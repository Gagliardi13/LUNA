// Boca guiada pelo som: analisa o áudio da Luna no exato momento em que ele toca
// e transforma em formas de boca (visemas). Como segue o som real, não sai de sincronia.
const clamp = (v, a = 0, b = 1) => Math.min(b, Math.max(a, v));
const SHAPES = ['jawOpen', 'viseme_aa', 'viseme_O', 'viseme_U', 'viseme_E', 'viseme_I', 'viseme_SS', 'viseme_FF', 'viseme_PP', 'browInnerUp'];

export class AudioLipsync {
  constructor(head) {
    this.head = head;
    this.cur = Object.fromEntries(SHAPES.map((k) => [k, 0]));
    this.active = false;
    this.level = 0;
    this.slow = 0; // média lenta do volume, para detectar ênfase
  }

  // liga o analisador na saída de voz da Luna (chamar depois de head.streamStart)
  attach() {
    const h = this.head;
    if (!h.streamWorkletNode || !h.audioCtx) return false;
    if (this.analyser && this.analyser.context === h.audioCtx) return true;
    this.analyser = h.audioCtx.createAnalyser();
    this.analyser.fftSize = 512;
    this.analyser.smoothingTimeConstant = 0.25;
    h.streamWorkletNode.connect(this.analyser);
    this.time = new Float32Array(this.analyser.fftSize);
    this.freq = new Uint8Array(this.analyser.frequencyBinCount);
    this.hz = h.audioCtx.sampleRate / this.analyser.fftSize;
    return true;
  }

  _band(a, b) {
    const i0 = Math.max(1, Math.floor(a / this.hz));
    const i1 = Math.min(this.freq.length - 1, Math.ceil(b / this.hz));
    let s = 0;
    for (let i = i0; i <= i1; i++) s += this.freq[i] * this.freq[i];
    return s / Math.max(1, i1 - i0 + 1);
  }

  // chamado a cada quadro (dt em ms)
  update(dt, speaking) {
    const h = this.head;
    const mt = h.mtAvatar;
    if (!this.analyser || !mt) return;

    const target = Object.fromEntries(SHAPES.map((k) => [k, 0]));
    if (speaking) {
      this.analyser.getFloatTimeDomainData(this.time);
      let sum = 0;
      for (let i = 0; i < this.time.length; i++) sum += this.time[i] * this.time[i];
      const rms = Math.sqrt(sum / this.time.length);
      const level = clamp((rms - 0.008) / 0.11);
      this.level = level;
      this.slow += (level - this.slow) * Math.min(1, dt / 600);

      this.analyser.getByteFrequencyData(this.freq);
      const f1 = this._band(250, 850);    // abertura (vogais abertas)
      const f2lo = this._band(850, 1700); // vogais posteriores (o, u)
      const f2hi = this._band(1700, 3300); // vogais anteriores (e, i)
      const sib = this._band(4200, 9000);  // chiados (s, x, f)
      const tot = f1 + f2lo + f2hi + sib + 1e-6;
      const r1 = f1 / tot, rlo = f2lo / tot, rhi = f2hi / tot, rs = sib / tot;
      const front = rhi / (rlo + rhi + 1e-6);
      const back = 1 - front;
      const sibil = clamp((rs - 0.12) * 4);
      const open = level * (1 - sibil * 0.6);

      target.jawOpen = open * 0.45;
      target.viseme_aa = open * clamp(r1 * 1.6) * (1 - front * 0.6);
      target.viseme_O = open * back * clamp((r1 + rlo) * 1.2) * 0.75;
      target.viseme_U = open * back * clamp(rlo * 2 - r1) * 0.45;
      target.viseme_E = open * front * 0.65;
      target.viseme_I = open * clamp((front - 0.55) * 2.5) * 0.45;
      target.viseme_SS = sibil * clamp(level * 3) * 0.7;
      target.viseme_FF = sibil * clamp(0.35 - level) * 0.6;
      // lábios se fecham entre as sílabas (m, p, b)
      target.viseme_PP = clamp(1 - level * 7) * 0.45;
      // ênfase: sobrancelhas sobem um pouco nos picos de voz
      target.browInnerUp = clamp((level - this.slow - 0.15) * 2) * 0.35;
      this.active = true;
    }

    // suavização: abre rápido, fecha um pouco mais devagar (como uma boca real)
    let any = false;
    for (const k of SHAPES) {
      const t = target[k];
      const rate = t > this.cur[k] ? 0.045 : 0.022; // por ms
      this.cur[k] += (t - this.cur[k]) * Math.min(1, dt * rate);
      if (this.cur[k] > 0.005) any = true;
      if (mt[k]) {
        const mouth = k !== 'browInnerUp';
        mt[k].realtime = (speaking && mouth) || this.cur[k] > 0.02 ? this.cur[k] : null;
        mt[k].needsUpdate = true;
      }
    }
    if (!speaking && !any && this.active) {
      for (const k of SHAPES) if (mt[k]) { mt[k].realtime = null; mt[k].needsUpdate = true; }
      this.active = false;
    }
  }
}
