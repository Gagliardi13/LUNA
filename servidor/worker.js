// Servidor intermediário da Sol e da Luna (Cloudflare Worker).
// Guarda as suas chaves (OpenAI e Gemini) e entrega aos apps só acessos temporários.
//
// Variáveis a configurar no painel do Cloudflare (Settings > Variables and Secrets):
//   OPENAI_API_KEY   (Secret)  sua chave da OpenAI, começa com "sk-"
//   APP_TOKEN        (Secret)  uma senha inventada por você; o app pede essa senha
//   ALLOWED_ORIGINS  (Text)    endereço do seu site, ex.: https://gagliardi13.github.io
//   MODEL            (Text, opcional) padrão: gpt-realtime-mini
//   EMO_MODEL        (Text, opcional) modelo das emoções; padrão: tenta gpt-4.1-nano, depois gpt-5.4-nano
//   GEMINI_API_KEY   (Secret)  chave do Google AI Studio (usada pela Luna)

const VOICES = ['marin', 'coral', 'shimmer', 'sage', 'cedar', 'alloy', 'ash', 'ballad', 'echo', 'verse'];

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    const allowed = (env.ALLOWED_ORIGINS || '')
      .split(',')
      .map((s) => s.trim().replace(/\/+$/, ''))
      .filter(Boolean);
    const originOk = allowed.length === 0 || allowed.includes(origin);

    const cors = {
      'Access-Control-Allow-Origin': originOk && origin ? origin : 'null',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, X-App-Token',
      'Access-Control-Max-Age': '86400',
      Vary: 'Origin',
    };
    const reply = (status, body) =>
      new Response(typeof body === 'string' ? body : JSON.stringify(body), {
        status,
        headers: { ...cors, 'Content-Type': 'application/json' },
      });

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

    const url = new URL(request.url);
    if (url.pathname === '/' && request.method === 'GET') return reply(200, { ok: true, servico: 'sol', rotas: ['/session', '/emocao', '/gemini-token'] });
    if (!['/session', '/emocao', '/gemini-token'].includes(url.pathname) || request.method !== 'POST') return reply(404, { erro: 'rota não encontrada' });
    if (!originOk) return reply(403, { erro: 'origem não autorizada' });
    if (!env.APP_TOKEN) return reply(500, { erro: 'Worker sem APP_TOKEN configurado' });
    if (!(await safeEqual(request.headers.get('X-App-Token') || '', env.APP_TOKEN))) return reply(401, { erro: 'senha incorreta' });
    if (url.pathname === '/gemini-token') return reply(...(await geminiToken(env)));
    if (!env.OPENAI_API_KEY) return reply(500, { erro: 'Worker sem OPENAI_API_KEY configurada' });

    let body = {};
    try {
      body = await request.json();
    } catch {}
    if (url.pathname === '/emocao') return reply(...(await emocao(body, env)));
    const voice = VOICES.includes(body.voice) ? body.voice : 'marin';

    const r = await fetch('https://api.openai.com/v1/realtime/client_secrets', {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        expires_after: { anchor: 'created_at', seconds: 120 },
        session: {
          type: 'realtime',
          model: env.MODEL || 'gpt-realtime-mini',
          audio: {
            input: {
              turn_detection: { type: 'semantic_vad', eagerness: 'auto', create_response: true, interrupt_response: true },
            },
            output: { voice },
          },
        },
      }),
    });
    const data = await r.text();
    if (!r.ok) return reply(r.status, { erro: 'OpenAI recusou', detalhe: data.slice(0, 500) });
    const json = JSON.parse(data);
    return reply(200, { value: json.value, expires_at: json.expires_at });
  },
};

// ---------- emoções ----------
const EMOCOES = ['neutra', 'feliz', 'risada', 'surpresa', 'espanto', 'triste', 'curiosa', 'pensativa', 'empolgada', 'vergonha', 'irritada', 'carinho', 'charmosa'];
const GESTOS = ['nenhum', 'sim', 'nao', 'ombros', 'surpresa', 'risada', 'animada'];
const EMO_PROMPT = `Você controla as reações de {NOME}, uma personagem que conversa por voz.
Receberá o contexto recente e um trecho novo.
- Se o trecho é DELE (o usuário falando, possivelmente incompleto): decida a reação de Sol ENQUANTO ESCUTA.
- Se o trecho é DELA ({NOME}): decida a emoção com que ela está falando.
Responda só JSON: {"emocao": uma de [${EMOCOES.join(', ')}], "intensidade": 0 a 1, "gesto": um de [${GESTOS.join(', ')}]}.
Regras: "nenhum" é o gesto mais comum; use gesto só quando a reação é clara.
"sim" = concordar acenando; "nao" = discordar; "ombros" = dúvida/sei lá; "surpresa"/"risada"/"animada" só para momentos fortes.
Intensidade baixa (0.3) para conversa comum; alta (0.8+) só para emoção evidente.
"charmosa" = um charme/flerte leve (sorriso de canto, piscadinha).`;

async function emocao(body, env) {
  const text = String(body.text || '').slice(0, 600);
  if (!text) return [400, { erro: 'sem texto' }];
  const nome = String(body.nome || 'Sol').replace(/[^\p{L} ]/gu, '').slice(0, 20) || 'Sol';
  const who = body.who === 'sol' || body.who === 'ela' ? `DELA (${nome})` : 'DELE';
  const context = Array.isArray(body.context) ? body.context.slice(-4).map((c) => String(c).slice(0, 300)).join('\n') : '';
  const messages = [
    { role: 'system', content: EMO_PROMPT.replaceAll('{NOME}', nome) },
    { role: 'user', content: `Contexto:\n${context || '(início)'}\n\nTrecho novo (${who}): ${text}` },
  ];
  const tries = env.EMO_MODEL
    ? [{ model: env.EMO_MODEL }]
    : [{ model: 'gpt-4.1-nano' }, { model: 'gpt-5.4-nano', reasoning_effort: 'none' }, { model: 'gpt-5.4-nano', reasoning_effort: 'minimal' }];
  let last = '';
  for (const t of tries) {
    const r = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...t, messages, response_format: { type: 'json_object' }, max_completion_tokens: 200 }),
    });
    const raw = await r.text();
    if (!r.ok) {
      last = `${t.model} ${r.status}: ${raw.slice(0, 200)}`;
      if (r.status === 401 || r.status === 429) break; // chave ou crédito: não adianta tentar outro
      continue;
    }
    try {
      const out = JSON.parse(JSON.parse(raw).choices[0].message.content);
      return [200, {
        emocao: EMOCOES.includes(out.emocao) ? out.emocao : 'neutra',
        intensidade: Math.min(1, Math.max(0, Number(out.intensidade) || 0.4)),
        gesto: GESTOS.includes(out.gesto) ? out.gesto : 'nenhum',
      }];
    } catch {
      last = `${t.model}: resposta inválida`;
    }
  }
  return [502, { erro: 'falha nas emoções', detalhe: last }];
}

// ---------- Gemini (Luna): token temporário de uso único ----------
async function geminiToken(env) {
  if (!env.GEMINI_API_KEY) return [500, { erro: 'Worker sem GEMINI_API_KEY configurada' }];
  const now = Date.now();
  const body = JSON.stringify({
    uses: 1,
    expireTime: new Date(now + 30 * 60 * 1000).toISOString(),
    newSessionExpireTime: new Date(now + 2 * 60 * 1000).toISOString(),
  });
  let last = '';
  for (const version of ['v1beta', 'v1alpha']) {
    const r = await fetch(`https://generativelanguage.googleapis.com/${version}/auth_tokens`, {
      method: 'POST',
      headers: { 'x-goog-api-key': env.GEMINI_API_KEY, 'Content-Type': 'application/json' },
      body,
    });
    const raw = await r.text();
    if (r.ok) {
      const j = JSON.parse(raw);
      if (j.name) return [200, { token: j.name, version }];
      last = 'resposta sem token: ' + raw.slice(0, 200);
    } else {
      last = `${version} ${r.status}: ${raw.slice(0, 300)}`;
      if (r.status !== 404) break;
    }
  }
  return [502, { erro: 'Gemini recusou o token', detalhe: last }];
}

// comparação de senha em tempo constante
async function safeEqual(a, b) {
  const enc = new TextEncoder();
  const [ha, hb] = await Promise.all([
    crypto.subtle.digest('SHA-256', enc.encode(a)),
    crypto.subtle.digest('SHA-256', enc.encode(b)),
  ]);
  const x = new Uint8Array(ha), y = new Uint8Array(hb);
  let d = 0;
  for (let i = 0; i < x.length; i++) d |= x[i] ^ y[i];
  return d === 0;
}
