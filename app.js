// Luna: rosto 3D realista + conversa ao vivo com o Gemini (voz e visão) + olhar que te segue.
import * as THREE from 'three';
import { TalkingHead } from './lib/talkinghead/talkinghead.mjs';
import { applyLook } from './look.js';
import { AudioLipsync } from './lipsync.js';
import { GeminiLive } from './gemini.js';
import { Vision } from './vision.js';
import { EmotionEngine } from './emotion.js';
import { PERSONA, SAUDACAO, preencher } from './persona.js';

const $ = (id) => document.getElementById(id);

// ---------- configurações salvas no aparelho ----------
const store = {
  get(k, d = '') { try { return localStorage.getItem('luna.' + k) ?? localStorage.getItem('sol.' + k) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem('luna.' + k, v); } catch {} },
};
$('fWorker').value = store.get('worker');
$('fToken').value = store.get('token');
$('fName').value = store.get('name');
$('fVoice').value = store.get('voice', 'Despina');
$('fBg').value = store.get('bg', '#000000');
$('fVision').value = store.get('vision', 'eco');
$('fFone').checked = store.get('fone', '0') === '1';
$('fPip').checked = store.get('pip', '1') === '1';
setBackground($('fBg').value);

function setBackground(c) {
  $('stage').style.background = c;
  $('bBg').value = c;
  $('fBg').value = c;
}

// ---------- rosto 3D ----------
let lipsync = null;
let tick = () => {};
const head = new TalkingHead($('avatar'), {
  ttsEndpoint: 'none',
  lipsyncModules: ['pt_br'],
  lipsyncLang: 'pt_br',
  cameraView: 'upper',
  cameraRotateEnable: false,
  modelFPS: 30,
  avatarIdleEyeContact: 0.6,
  avatarSpeakingEyeContact: 0.75,
  avatarIdleHeadMove: 0.6,
  avatarSpeakingHeadMove: 0.75,
  update: (dt) => { lipsync?.update(dt, head.isSpeaking); tick(dt); },
});

// "você", do ponto de vista dela: um ponto em frente à tela que acompanha seu rosto na câmera
const you = new THREE.Object3D();
let avatarReady = false;

head.showAvatar(
  { url: './avatars/luna.glb', body: 'F', avatarMood: 'neutral', lipsyncLang: 'pt_br' },
  (e) => { if (e.lengthComputable) $('bar').style.width = Math.round((e.loaded / e.total) * 100) + '%'; }
).then(() => {
  applyLook(head); // luz de estúdio, óculos, cabelo e enquadramento
  head.scene.add(you);
  you.position.copy(head.camera.position);
  head.speakTo = you;
  avatarReady = true;
  $('bar').style.width = '100%';
  setStatus('Luna pronta.');
  $('btnStart').disabled = false;
}).catch((e) => setStatus('Erro ao carregar a Luna: ' + e.message, true));

function setStatus(msg, err = false) {
  $('setupStatus').textContent = msg;
  $('setupStatus').className = err ? 'err' : '';
}
function setState(cls, text) {
  $('dot').className = 'dot ' + cls;
  $('state').textContent = text;
}
let toastTimer;
function toast(msg, ms = 6000) {
  $('toast').textContent = msg;
  $('toast').style.display = 'block';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => ($('toast').style.display = 'none'), ms);
}

// ---------- estado da conversa ----------
let gemini = null, vision = null, emotions = null;
let micStream = null, micCtx = null, micNode = null;
let muted = false, camOn = true, subsOn = true, fone = false, visionMode = 'eco';
let lunaSpeaking = false, userSpeaking = false, discarding = false;
let newTurn = true;
let lunaLine = '', userLine = '', sentence = '';
let lastFrame = 0, sessionStart = 0;

// ---------- começar ----------
$('btnStart').onclick = async () => {
  const worker = $('fWorker').value.trim();
  const token = $('fToken').value.trim();
  const name = $('fName').value.trim();
  if (!worker || !token) return setStatus('Preencha o endereço do servidor e a senha.', true);
  fone = $('fFone').checked;
  visionMode = $('fVision').value;
  for (const [k, v] of [['worker', worker], ['token', token], ['name', name], ['voice', $('fVoice').value], ['bg', $('fBg').value], ['vision', visionMode], ['fone', fone ? '1' : '0'], ['pip', $('fPip').checked ? '1' : '0']]) store.set(k, v);

  $('btnStart').disabled = true;
  try {
    // 1) áudio de saída (precisa ser iniciado por um toque, regra dos navegadores)
    await head.streamStart(
      { sampleRate: 24000, lipsyncType: 'visemes', lipsyncLang: 'pt_br', waitForAudioChunks: true },
      () => { lunaSpeaking = true; setState('speaking', 'Luna falando'); $('tapHint').style.display = fone ? 'none' : 'block'; },
      () => { lunaSpeaking = false; $('tapHint').style.display = 'none'; setState('', muted ? 'Microfone desligado' : 'Pode falar'); }
    );

    lipsync = new AudioLipsync(head);
    lipsync.attach(); // a boca passa a seguir o som real da voz

    // 2) microfone
    setStatus('Pedindo acesso ao microfone…');
    micStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
    });
    micCtx = new AudioContext();
    await micCtx.audioWorklet.addModule('./mic-worklet.js');
    const src = micCtx.createMediaStreamSource(micStream);
    micNode = new AudioWorkletNode(micCtx, 'mic-capture');
    src.connect(micNode);
    const sink = micCtx.createGain(); // mantém o processador ativo sem tocar o som do microfone
    sink.gain.value = 0;
    micNode.connect(sink).connect(micCtx.destination);
    const analyser = micCtx.createAnalyser();
    src.connect(analyser);
    micNode.port.onmessage = (e) => {
      if (muted || !gemini?.ready) return;
      if (lunaSpeaking && !fone) return; // sem fone: não envia enquanto ela fala (ela não se ouve)
      gemini.sendAudio(e.data);
    };
    head.startListening(analyser, { listeningSilenceThresholdMs: 800 }, onListening);

    // 3) câmera
    if (visionMode !== 'off') {
      setStatus('Pedindo acesso à câmera…');
      vision = new Vision($('pip'));
      try {
        await vision.start();
        vision.addEventListener('face', (e) => onFace(e.detail));
        vision.addEventListener('face-unavailable', () => toast('O acompanhamento do rosto não carregou neste aparelho. A conversa e a visão continuam.'));
      } catch (e) {
        vision = null;
        toast('Câmera indisponível: ' + e.message);
      }
    }
    camOn = !!vision;
    showPip($('fPip').checked && !!vision);
    $('bCam').classList.toggle('on', camOn);
    $('bCam').classList.toggle('off', !camOn);

    // 4) Gemini
    setStatus('Conectando com a Luna…');
    gemini = new GeminiLive({
      workerUrl: worker,
      appToken: token,
      voice: $('fVoice').value,
      systemPrompt: preencher(PERSONA, name),
    });
    wireGemini(gemini);
    await gemini.connect();

    emotions = new EmotionEngine({ workerUrl: worker, appToken: token, nome: 'Luna', onReaction: react, onError: () => {} });

    // 5) entra na conversa
    $('setup').style.display = 'none';
    $('ui').classList.add('on');
    sessionStart = Date.now();
    navigator.wakeLock?.request('screen').catch(() => {});
    sendFrame(true);
    setTimeout(() => gemini.sendText(preencher(SAUDACAO, name)), 400);
    setState('', 'Pode falar');
  } catch (e) {
    console.error(e);
    setStatus(e.message || String(e), true);
    $('btnStart').disabled = false;
    cleanup();
  }
};

// ---------- eventos do Gemini ----------
function wireGemini(g) {
  g.addEventListener('audio', (e) => {
    if (discarding) return;
    const { buffer } = e.detail;
    if (newTurn) { newTurn = false; lunaLine = ''; }
    if (!lipsync?.analyser) lipsync?.attach();
    head.streamAudio({ audio: buffer });
  });
  g.addEventListener('model-text', (e) => {
    if (discarding) return;
    if (newTurn) { newTurn = false; lunaLine = ''; }
    lunaLine += e.detail;
    sentence += e.detail;
    if (/[.!?…]\s*$/.test(sentence) || sentence.length > 110) {
      emotions?.analyze('ela', sentence, { urgent: true });
      sentence = '';
    }
    showSubs();
  });
  g.addEventListener('user-text', (e) => {
    userLine += e.detail;
    emotions?.analyze('user', userLine);
    showSubs();
  });
  g.addEventListener('interrupted', () => {
    head.streamInterrupt();
    discarding = false;
    endTurn();
  });
  g.addEventListener('turn-complete', () => {
    head.streamNotifyEnd();
    if (discarding) discarding = false;
    endTurn();
  });
  g.addEventListener('reconnecting', () => setState('thinking', 'Reconectando…'));
  g.addEventListener('ready', (e) => { if (e.detail.resumed) setState('', 'Pode falar'); });
  g.addEventListener('closed', (e) => { setState('off', 'Desconectada'); toast('A conexão com a Luna caiu (' + (e.detail.reason || e.detail.code) + '). Toque em Encerrar e comece de novo.'); });
  g.addEventListener('error', (e) => toast(String(e.detail)));
  g.addEventListener('usage', (e) => updateMeter(e.detail));
}

function endTurn() {
  if (lunaLine.trim()) emotions?.remember('ela', lunaLine);
  if (sentence.trim()) emotions?.analyze('ela', sentence, { urgent: true });
  sentence = '';
  newTurn = true;
}

// você começou / parou de falar (detecção local, no aparelho)
function onListening(ev) {
  if (ev === 'start') {
    userSpeaking = true;
    userLine = '';
    if (!lunaSpeaking) setState('listening', 'Ouvindo você');
    sendFrame(true); // talvez você esteja mostrando algo: manda a imagem já
  } else if (ev === 'stop') {
    userSpeaking = false;
    if (userLine.trim()) emotions?.remember('user', userLine);
    if (!lunaSpeaking && !muted) setState('thinking', 'Pensando…');
    setTimeout(() => { if (!lunaSpeaking && !userSpeaking) setState('', muted ? 'Microfone desligado' : 'Pode falar'); }, 6000);
  }
}

// enquanto você fala: ela escuta "de verdade" (acenos leves, sobrancelha, olhar atento)
let nextListenCue = 0;
tick = () => {
  if (!userSpeaking || lunaSpeaking || !avatarReady) return;
  const now = performance.now();
  if (now < nextListenCue) return;
  nextListenCue = now + 2200 + Math.random() * 3000;
  const r = Math.random();
  if (r < 0.5) head.animQueue.push(head.animFactory({ name: 'escuta', dt: [220, 260, 320], vs: { headMove: [0], headRotateX: [0.07, -0.015, 0] } }));
  else if (r < 0.75) head.animQueue.push(head.animFactory({ name: 'escuta', dt: [300, 900, 400], vs: { browInnerUp: [0.35, 0.35, 0], mouthSmile: [0.15, 0.15, 0] } }));
  else head.animQueue.push(head.animFactory({ name: 'escuta', dt: [400, 1200, 500], vs: { headRotateZ: [0.05, 0.05, 0] } }));
};

// tocar nela interrompe (útil sem fone)
$('avatar').addEventListener('pointerdown', () => {
  if (!lunaSpeaking) return;
  head.streamInterrupt();
  discarding = true; // ignora o resto desta resposta
  lunaSpeaking = false;
  $('tapHint').style.display = 'none';
  setState('listening', 'Pode falar');
});

// ---------- emoções ----------
const EMO = {
  feliz: { emoji: '😊', mood: 'happy' },
  risada: { emoji: '😂', mood: 'happy' },
  surpresa: { emoji: '😳' },
  espanto: { emoji: '😱' },
  triste: { emoji: '😔', mood: 'sad' },
  curiosa: { emoji: '🤔' },
  pensativa: { emoji: '🤔' },
  empolgada: { emoji: '🤩', mood: 'happy' },
  vergonha: { emoji: '😊' },
  irritada: { emoji: '😒', mood: 'angry' },
  carinho: { emoji: '🥰', mood: 'love' },
  charmosa: { emoji: ['😏', '😉'] },
};
let lastEmoji = 0, moodTimer = null;
function expression(em) {
  let e = head.animEmojis[em];
  if (e && e.link) e = head.animEmojis[e.link];
  if (e) head.animQueue.push(head.animFactory(e));
}
function setMoodFor(mood, ms) {
  try { head.setMood(mood); } catch {}
  clearTimeout(moodTimer);
  moodTimer = setTimeout(() => { try { head.setMood('neutral'); } catch {} }, ms);
}
function react(data) {
  const { emocao = 'neutra', intensidade = 0.4, gesto = 'nenhum' } = data || {};
  const m = EMO[emocao];
  const now = performance.now();
  if (m && intensidade >= 0.35 && now - lastEmoji > 2500) {
    const em = Array.isArray(m.emoji) ? m.emoji[Math.floor(Math.random() * m.emoji.length)] : m.emoji;
    expression(em);
    lastEmoji = now;
  }
  if (m?.mood && intensidade >= 0.5) setMoodFor(m.mood, 3000 + intensidade * 4000);
  if (gesto === 'sim') expression('yes');
  else if (gesto === 'nao') expression('no');
  else if (gesto === 'ombros') { try { head.playGesture('shrug', 2); } catch {} }
}

// ---------- seu rosto: olhar e expressões ----------
let faceSeen = 0, smileSince = 0, surpriseSince = 0, lastMirror = 0, lastCount = 0;
const _right = new THREE.Vector3(), _up = new THREE.Vector3();
function onFace(f) {
  const now = performance.now();
  if (!f.count) return;
  faceSeen = now;
  // posição: a câmera do aparelho fica em cima da tela; a Luna olha para onde você está
  if (avatarReady) {
    const cam = head.camera;
    const dist = cam.position.length() || 3;
    const yaw = (0.5 - f.x) * -0.9;   // você se move para a esquerda da tela → ela vira para lá
    const pitch = (0.45 - f.y) * 0.5;
    _right.set(1, 0, 0).applyQuaternion(cam.quaternion);
    _up.set(0, 1, 0).applyQuaternion(cam.quaternion);
    you.position.copy(cam.position)
      .addScaledVector(_right, Math.tan(yaw) * dist)
      .addScaledVector(_up, Math.tan(pitch) * dist);
  }
  // alguém novo apareceu: manda a imagem já, para ela notar
  if (f.count > lastCount && sessionStart && now - sessionStart > 3000) sendFrame(true);
  lastCount = f.count;
  // espelha suas expressões enquanto ela não está falando
  if (lunaSpeaking || now - lastMirror < 9000) return;
  if (f.smile > 0.55) { smileSince ||= now; } else smileSince = 0;
  if (f.jawOpen > 0.4 && f.eyeWide > 0.3) { surpriseSince ||= now; } else surpriseSince = 0;
  if (smileSince && now - smileSince > 600) { expression('😊'); setMoodFor('happy', 3500); lastMirror = now; smileSince = 0; }
  else if (surpriseSince && now - surpriseSince > 400) { expression('😳'); lastMirror = now; surpriseSince = 0; }
}

// ---------- imagens para o Gemini ----------
function sendFrame(force = false) {
  if (!vision || !camOn || !gemini?.ready || visionMode === 'off') return;
  const now = performance.now();
  if (!force && now - lastFrame < 500) return;
  const img = vision.snapshot(512, 0.6);
  if (!img) return;
  gemini.sendImage(img);
  lastFrame = now;
}
setInterval(() => {
  if (!sessionStart) return;
  const since = performance.now() - lastFrame;
  if (visionMode === 'full' && since >= 1000) sendFrame();
  else if (visionMode === 'eco' && (userSpeaking ? since >= 1500 : since >= 8000)) sendFrame();
}, 250);

// ---------- legendas e consumo ----------
function showSubs() {
  if (!subsOn) { $('subs').innerHTML = ''; return; }
  const tail = lunaLine.length > 170 ? '…' + lunaLine.slice(-170) : lunaLine;
  $('subs').innerHTML = (userLine ? `<span class="you">Você: ${esc(userLine.slice(-140))}</span>` : '') + (tail ? `<span>${esc(tail)}</span>` : '');
}
const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
function updateMeter(u) {
  const min = Math.max(1, Math.round((Date.now() - sessionStart) / 60000));
  $('meter').textContent = `${min} min · ${(u.total / 1000).toFixed(1)}k tokens`;
}
setInterval(() => { if (sessionStart && gemini) updateMeter(gemini.usage); }, 30000);

function showPip(on) {
  $('pip').style.opacity = on ? '1' : '0';
  $('pip').style.pointerEvents = on ? 'auto' : 'none';
}

// ---------- botões ----------
$('bMic').onclick = () => {
  muted = !muted;
  $('bMic').classList.toggle('on', !muted);
  $('bMic').classList.toggle('off', muted);
  setState(muted ? 'off' : '', muted ? 'Microfone desligado' : 'Pode falar');
};
$('bCam').onclick = async () => {
  if (vision && camOn) {
    vision.stop(); vision = null; camOn = false;
  } else if (!vision) {
    try {
      vision = new Vision($('pip'));
      await vision.start();
      vision.addEventListener('face', (e) => onFace(e.detail));
      camOn = true;
      if (visionMode === 'off') visionMode = 'eco';
    } catch (e) { toast('Câmera indisponível: ' + e.message); vision = null; camOn = false; }
  }
  showPip(camOn && $('fPip').checked);
  $('bCam').classList.toggle('on', camOn);
  $('bCam').classList.toggle('off', !camOn);
};
$('bBg').oninput = (e) => { setBackground(e.target.value); store.set('bg', e.target.value); };
$('fBg').oninput = (e) => setBackground(e.target.value);
$('bSubs').onclick = () => { subsOn = !subsOn; $('bSubs').classList.toggle('on', subsOn); showSubs(); };
$('bEnd').onclick = () => {
  cleanup();
  $('ui').classList.remove('on');
  $('setup').style.display = '';
  $('btnStart').disabled = false;
  setStatus('Conversa encerrada.');
};

function cleanup() {
  try { gemini?.close(); } catch {}
  try { head.stopListening(); head.streamStop(); } catch {}
  try { vision?.stop(); } catch {}
  try { micStream?.getTracks().forEach((t) => t.stop()); micCtx?.close(); } catch {}
  gemini = null; vision = null; micStream = null; micCtx = null;
  sessionStart = 0; lunaSpeaking = false; userSpeaking = false; discarding = false; newTurn = true;
  lunaLine = ''; userLine = ''; showSubs();
}

// para testes no computador (console)
window.luna = { head, react, expression, get gemini() { return gemini; } };
