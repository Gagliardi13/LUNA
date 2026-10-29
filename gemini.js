// Conversa ao vivo com o Gemini (voz + visão) por WebSocket.
// A chave fica no Cloudflare; aqui só usamos um token temporário de uso único.
// Reconecta sozinho (o Google encerra conexões a cada ~10 min) sem perder o assunto.

export const GEMINI_MODEL = 'gemini-3.8-live';

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

export class GeminiLive extends EventTarget {
  constructor({ workerUrl, appToken, voice, systemPrompt, tools = null, search = true, mediaResolution = 'MEDIA_RESOLUTION_LOW', model = GEMINI_MODEL }) {
    super();
    this.provider = 'gemini';
    this.inputRate = 16000; // o Gemini recebe áudio a 16 kHz
    this.workerUrl = workerUrl.replace(/\/+$/, '');
    this.appToken = appToken;
    this.voice = voice;
    this.systemPrompt = systemPrompt;
    this.model = model;
    this.tools = tools;
    this.search = search;
    this.mediaResolution = mediaResolution;
    this.handle = null; // para retomar a sessão
    this.closing = false;
    this.ready = false;
    this.retries = 0;
    this.usage = { prompt: 0, response: 0, total: 0 };
  }

  _emit(type, detail) { this.dispatchEvent(new CustomEvent(type, { detail })); }

  async _token() {
    let r;
    try {
      r = await fetch(this.workerUrl + '/gemini-token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-App-Token': this.appToken },
        body: '{}',
      });
    } catch (e) {
      throw new Error('Não consegui falar com o servidor (Worker). Confira o endereço. ' + e.message);
    }
    const txt = await r.text();
    if (r.status === 401) throw new Error('Senha do app incorreta.');
    if (r.status === 404) throw new Error('O Worker ainda não tem a parte da Luna. Cole o worker.js novo no Cloudflare.');
    if (r.status === 429) throw new Error('quota: ' + txt.slice(0, 200));
    if (!r.ok) throw new Error(`Servidor respondeu ${r.status}: ${txt.slice(0, 300)}`);
    return JSON.parse(txt);
  }

  async connect() {
    this.closing = false;
    const { token, version } = await this._token();
    const url = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.${version}.GenerativeService.BidiGenerateContentConstrained?access_token=${encodeURIComponent(token)}`;
    const ws = (this.ws = new WebSocket(url));
    this.ready = false;
    let opened = false; // esta tentativa chegou a ficar pronta?

    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('O Gemini demorou demais para responder.')), 20000);
      ws.onopen = () => {
        const setup = {
          model: `models/${this.model}`,
          generationConfig: {
            responseModalities: ['AUDIO'],
            speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: this.voice } } },
            mediaResolution: this.mediaResolution, // baixa = bem mais barato; média = consegue ler texto da tela
          },
          systemInstruction: { parts: [{ text: this.systemPrompt }] },
          inputAudioTranscription: {},
          outputAudioTranscription: {},
          contextWindowCompression: { slidingWindow: {} }, // conversa sem limite de tempo
          sessionResumption: this.handle ? { handle: this.handle } : {},
        };
        setup.tools = [];
        if (this.tools) setup.tools.push({ functionDeclarations: this.tools });
        if (this.search) setup.tools.push({ googleSearch: {} }); // pesquisa no Google durante a conversa
        if (!setup.tools.length) delete setup.tools;
        ws.send(JSON.stringify({ setup }));
      };
      ws.onmessage = async (ev) => {
        let msg;
        try {
          msg = JSON.parse(typeof ev.data === 'string' ? ev.data : await ev.data.text());
        } catch { return; }
        if (msg.setupComplete && !opened) {
          opened = true;
          this.ready = true;
          this.retries = 0;
          clearTimeout(timer);
          resolve();
          this._emit('ready', { resumed: !!this.handle });
        }
        this._onMessage(msg);
      };
      ws.onerror = () => {};
      ws.onclose = (ev) => {
        clearTimeout(timer);
        if (ws !== this.ws && opened) return; // conexão antiga (já trocada): ignora
        this.ready = false;
        if (!opened) {
          reject(new Error(`O Gemini fechou a conexão (${ev.code}) ${ev.reason || ''}`.trim()));
          return;
        }
        this._onClose(ev);
      };
    });
  }

  async _onClose(ev) {
    if (this.closing) { this._emit('closed', { code: ev.code, reason: ev.reason }); return; }
    // cota esgotada: não adianta tentar de novo (o app troca para a OpenAI)
    if (/quota|exceeded|RESOURCE_EXHAUSTED|billing/i.test(ev.reason || '')) {
      this._emit('closed', { code: ev.code, reason: ev.reason, quota: true });
      return;
    }
    // fechamento inesperado ou fim de ciclo de 10 min: reconecta retomando a sessão
    if (this.retries >= 4) {
      this._emit('closed', { code: ev.code, reason: ev.reason || 'falhou ao reconectar' });
      return;
    }
    this.retries++;
    this._emit('reconnecting', { code: ev.code, reason: ev.reason });
    await new Promise((r) => setTimeout(r, 400 * this.retries));
    try {
      await this.connect();
    } catch (e) {
      this._emit('error', e.message);
      this._onClose({ code: 0, reason: e.message });
    }
  }

  _onMessage(msg) {
    if (msg.sessionResumptionUpdate) {
      const u = msg.sessionResumptionUpdate;
      if (u.resumable !== false && u.newHandle) this.handle = u.newHandle;
    }
    if (msg.goAway) {
      // o Google avisa antes de encerrar: reconecta já, de forma transparente
      this._emit('goaway', msg.goAway.timeLeft);
      const old = this.ws;
      setTimeout(() => { try { old.close(4000, 'troca de conexão'); } catch {} }, 50);
    }
    if (msg.usageMetadata) {
      const m = msg.usageMetadata;
      this.usage.prompt += m.promptTokenCount || 0;
      this.usage.response += m.responseTokenCount || m.candidatesTokenCount || 0;
      this.usage.total += m.totalTokenCount || 0;
      this._emit('usage', this.usage);
    }
    if (msg.toolCall?.functionCalls?.length) this._emit('tool-call', msg.toolCall.functionCalls);
    const sc = msg.serverContent;
    if (!sc) return;
    if (sc.interrupted) this._emit('interrupted');
    if (sc.inputTranscription?.text) this._emit('user-text', sc.inputTranscription.text);
    if (sc.outputTranscription?.text) this._emit('model-text', sc.outputTranscription.text);
    for (const part of sc.modelTurn?.parts || []) {
      const d = part.inlineData;
      if (d && d.data && /^audio\//.test(d.mimeType || 'audio/pcm')) {
        const rate = Number((/rate=(\d+)/.exec(d.mimeType || '') || [])[1]) || 24000;
        this._emit('audio', { buffer: fromBase64(d.data), rate });
      }
    }
    if (sc.generationComplete) this._emit('generation-complete');
    if (sc.turnComplete) this._emit('turn-complete');
  }

  _send(obj) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN && this.ready) this.ws.send(JSON.stringify(obj));
  }

  // áudio do microfone: PCM 16 bits, 16 kHz
  sendAudio(int16buffer) {
    this._send({ realtimeInput: { audio: { data: toBase64(int16buffer), mimeType: 'audio/pcm;rate=16000' } } });
  }
  // imagem da câmera (JPEG em base64, sem o prefixo data:)
  sendImage(b64jpeg) {
    this._send({ realtimeInput: { video: { data: b64jpeg, mimeType: 'image/jpeg' } } });
  }
  // responde aos comandos executados, para ela continuar a conversa
  sendToolResponse(functionResponses) {
    this._send({ toolResponse: { functionResponses } });
  }
  sendText(text) {
    this._send({ realtimeInput: { text } });
  }
  // reconecta mantendo a conversa (ex.: para mudar a resolução das imagens ao compartilhar a tela)
  reconfigure(changes) {
    Object.assign(this, changes);
    try { this.ws && this.ws.close(4001, 'reconfigurar'); } catch {}
  }
  close() {
    this.closing = true;
    try { this.ws && this.ws.close(1000, 'fim'); } catch {}
  }
}
