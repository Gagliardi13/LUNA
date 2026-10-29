// Captura do microfone: converte para PCM 16 bits (16 ou 24 kHz) e envia blocos de ~100 ms.
class MicCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.setRate(16000);
    this.n = 0;
    this.enabled = true;
    this.port.onmessage = (e) => {
      if (e.data && 'enabled' in e.data) this.enabled = e.data.enabled;
      if (e.data && e.data.rate) this.setRate(e.data.rate); // 16 kHz (Gemini) ou 24 kHz (OpenAI)
    };
  }
  setRate(rate) {
    this.ratio = sampleRate / rate;
    this.pos = 0;
    this.out = new Int16Array(Math.round(rate / 10)); // blocos de ~100 ms
    this.n = 0;
  }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch) return true;
    // reamostragem simples (média do intervalo), suficiente para voz
    while (this.pos < ch.length) {
      const i0 = Math.floor(this.pos);
      const i1 = Math.min(ch.length, Math.floor(this.pos + this.ratio));
      let sum = 0, k = 0;
      for (let i = i0; i < Math.max(i1, i0 + 1); i++) { sum += ch[i]; k++; }
      let v = sum / k;
      v = Math.max(-1, Math.min(1, v));
      this.out[this.n++] = v < 0 ? v * 0x8000 : v * 0x7fff;
      if (this.n === this.out.length) {
        if (this.enabled) this.port.postMessage(this.out.buffer.slice(0));
        this.n = 0;
      }
      this.pos += this.ratio;
    }
    this.pos -= ch.length;
    return true;
  }
}
registerProcessor('mic-capture', MicCapture);
