// Plano B: conversa ao vivo pela OpenAI (Realtime), com a MESMA interface do gemini.js.
// Usado automaticamente quando a cota do Gemini acaba. Usa o mesmo Worker da Sol (/session).

export const OPENAI_MODEL = 'gpt-realtime-mini';

function toBase64(buf) {
  const bytes = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
function fromBase64(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out.buffer;
}
// esquema no formato do Gemini (OBJECT/STRING) → JSON Schema (object/string)
function toJsonSchema(x) {
  if (Array.isArray(x)) return x.map(toJsonSchema);
  if (!x || typeof x !== 'object') return x;
  const o = {};
  for (const [k, v] of Object.entries(x)) o[k] = k === 'type' && typeof v === 'string' ? v.toLowerCase() : toJsonSchema(v);
  return o;
}

export class OpenAILive extends EventTarget {
  constructor({ workerUrl, appToken, voice = 'marin', systemPrompt, tools = null, model = OPENAI_MODEL }) {
    super();
    this.provider = 'openai';
    this.inputRate = 24000; // a OpenAI recebe áudio a 24 kHz
    this.workerUrl = workerUrl.replace(/\/+$/, '');
    this.appToken = appToken;
    this.voice = voice;
    this.systemPrompt = systemPrompt;
    this.tools = tools;
    this.model = model;
    this.ready = false;
    this.closing = false;
    this.speaking = false;
    this.usage = { prompt: 0, response: 0, total: 0 };
    this.mediaResolution = 'n/a';
  }
  _emit(type, detail) { this.dispatchEvent(new CustomEvent(type, { detail })); }

  async connect() {
    let r;
    try {
      r = await fetch(this.workerUrl + '/session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-App-Token': this.appToken },
        body: JSON.stringify({ voice: this.voice }),
      });
    } catch (e) {
      throw new Error('Não consegui falar com o servidor (Worker): ' + e.message);
    }
    const txt = await r.text();
    if (!r.ok) throw new Error(`OpenAI indisponível (${r.status}): ${txt.slice(0, 200)}`);
    const { value } = JSON.parse(txt);

    const ws = (this.ws = new WebSocket(`wss://api.openai.com/v1/realtime?model=${encodeURIComponent(this.model)}`, [
      'realtime',
      'openai-insecure-api-key.' + value, // chave temporária (expira em minutos), não a chave real
    ]));
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('A OpenAI demorou demais para responder.')), 20000);
      let opened = false;
      ws.onopen = () => {
        ws.send(JSON.stringify({
          type: 'session.update',
          session: {
            type: 'realtime',
            instructions: this.systemPrompt,
            audio: {
              input: {
                format: { type: 'audio/pcm', rate: 24000 },
                turn_detection: { type: 'semantic_vad', create_response: true, interrupt_response: true },
                transcription: { model: 'gpt-4o-mini-transcribe', language: 'pt' },
              },
              output: { format: { type: 'audio/pcm', rate: 24000 }, voice: this.voice },
            },
            ...(this.tools ? {
              tools: this.tools.map((t) => ({ type: 'function', name: t.name, description: t.description, parameters: toJsonSchema(t.parameters) })),
              tool_choice: 'auto',
            } : {}),
          },
        }));
      };
      ws.onmessage = (ev) => {
        let msg;
        try { msg = JSON.parse(ev.data); } catch { return; }
        if (!opened && (msg.type === 'session.updated' || msg.type === 'session.created')) {
          if (msg.type === 'session.updated') {
            opened = true;
            this.ready = true;
            clearTimeout(timer);
            resolve();
            this._emit('ready', { resumed: false });
          }
        }
        if (msg.type === 'error' && !opened) {
          clearTimeout(timer);
          reject(new Error('OpenAI: ' + (msg.error?.message || 'erro')));
          return;
        }
        this._onMessage(msg);
      };
      ws.onclose = (ev) => {
        clearTimeout(timer);
        this.ready = false;
        if (!opened) { reject(new Error(`A OpenAI fechou a conexão (${ev.code}) ${ev.reason || ''}`)); return; }
        this._emit('closed', { code: ev.code, reason: ev.reason || 'conexão encerrada' });
      };
    });
  }

  _onMessage(msg) {
    switch (msg.type) {
      case 'response.output_audio.delta':
        this.speaking = true;
        this._emit('audio', { buffer: fromBase64(msg.delta), rate: 24000 });
        break;
      case 'response.output_audio_transcript.delta':
        this._emit('model-text', msg.delta || '');
        break;
      case 'conversation.item.input_audio_transcription.delta':
        this._emit('user-text', msg.delta || '');
        break;
      case 'input_audio_buffer.speech_started':
        if (this.speaking) { this.speaking = false; this._emit('interrupted'); }
        break;
      case 'response.done': {
        this.speaking = false;
        const resp = msg.response || {};
        const u = resp.usage;
        if (u) {
          this.usage.prompt += u.input_tokens || 0;
          this.usage.response += u.output_tokens || 0;
          this.usage.total += u.total_tokens || 0;
          this._emit('usage', this.usage);
        }
        const calls = (resp.output || []).filter((it) => it.type === 'function_call');
        if (calls.length) {
          this._emit('tool-call', calls.map((c) => {
            let args = {};
            try { args = JSON.parse(c.arguments || '{}'); } catch {}
            return { id: c.call_id, name: c.name, args };
          }));
        }
        this._emit('turn-complete');
        break;
      }
      case 'error':
        this._emit('error', msg.error?.message || 'erro da OpenAI');
        break;
    }
  }

  _send(obj) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN && this.ready) this.ws.send(JSON.stringify(obj));
  }
  // áudio do microfone: PCM 16 bits, 24 kHz
  sendAudio(int16buffer) {
    this._send({ type: 'input_audio_buffer.append', audio: toBase64(int16buffer) });
  }
  // imagens custam mais na OpenAI: o app manda menos vezes
  sendImage(b64jpeg) {
    this._send({
      type: 'conversation.item.create',
      item: { type: 'message', role: 'user', content: [{ type: 'input_image', image_url: 'data:image/jpeg;base64,' + b64jpeg }] },
    });
  }
  sendText(text) {
    this._send({ type: 'conversation.item.create', item: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] } });
    this._send({ type: 'response.create' });
  }
  sendToolResponse(functionResponses) {
    for (const r of functionResponses) {
      this._send({ type: 'conversation.item.create', item: { type: 'function_call_output', call_id: r.id, output: JSON.stringify(r.response) } });
    }
    // proteção: se ela só chamar ferramentas em sequência, sem falar, para de pedir novas respostas
    const now = Date.now();
    this.toolChain = now - (this.lastTool || 0) < 4000 ? (this.toolChain || 0) + 1 : 1;
    this.lastTool = now;
    if (this.toolChain <= 3) this._send({ type: 'response.create' });
  }
  reconfigure() { /* nada a mudar na OpenAI */ }
  close() {
    this.closing = true;
    try { this.ws && this.ws.close(1000, 'fim'); } catch {}
  }
}

// a cota do Gemini acabou? (ou o plano não cobre o modelo)
export function isQuotaError(text) {
  return /quota|exceeded|RESOURCE_EXHAUSTED|rate.?limit|\b429\b|billing/i.test(String(text || ''));
}
