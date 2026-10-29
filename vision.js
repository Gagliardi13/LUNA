// Câmera: tira fotos para o Gemini "ver" e acompanha o seu rosto no próprio aparelho
// (MediaPipe) para a Luna te olhar nos olhos e reagir às suas expressões.
const MP = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.2.0';
const FACE_MODEL = 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task';

export class Vision extends EventTarget {
  constructor(video) {
    super();
    this.video = video;
    this.canvas = document.createElement('canvas');
    this.landmarker = null;
    this.running = false;
  }
  _emit(type, detail) { this.dispatchEvent(new CustomEvent(type, { detail })); }

  async start() {
    this.stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } },
      audio: false,
    });
    this.video.srcObject = this.stream;
    this.video.muted = true;
    this.video.playsInline = true;
    await this.video.play();
    this.running = true;
    this._initFace(); // em paralelo; se falhar, a câmera continua funcionando para o Gemini
  }

  async _initFace() {
    try {
      const { FaceLandmarker, FilesetResolver } = await import(`${MP}/vision_bundle.mjs`);
      const fileset = await FilesetResolver.forVisionTasks(`${MP}/wasm`);
      const make = (delegate) => FaceLandmarker.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: FACE_MODEL, delegate },
        runningMode: 'VIDEO',
        numFaces: 2,
        outputFaceBlendshapes: true,
      });
      try { this.landmarker = await make('GPU'); } catch { this.landmarker = await make('CPU'); }
      this._emit('face-ready');
      this._loop();
    } catch (e) {
      this._emit('face-unavailable', e.message || String(e));
    }
  }

  _loop() {
    if (!this.running || !this.landmarker) return;
    try {
      if (this.video.readyState >= 2) {
        const res = this.landmarker.detectForVideo(this.video, performance.now());
        const faces = res.faceLandmarks || [];
        if (!faces.length) {
          this._emit('face', { count: 0 });
        } else {
          // rosto principal = o maior (mais perto da câmera)
          let best = 0, bestSize = 0;
          faces.forEach((lm, i) => {
            const size = Math.abs(lm[33].x - lm[263].x);
            if (size > bestSize) { bestSize = size; best = i; }
          });
          const lm = faces[best];
          const bs = {};
          for (const c of res.faceBlendshapes?.[best]?.categories || []) bs[c.categoryName] = c.score;
          const avg = (a, b) => ((bs[a] || 0) + (bs[b] || 0)) / 2;
          this._emit('face', {
            count: faces.length,
            x: lm[1].x, y: lm[1].y, // ponta do nariz, 0..1 na imagem da câmera
            size: bestSize,
            smile: avg('mouthSmileLeft', 'mouthSmileRight'),
            jawOpen: bs.jawOpen || 0,
            eyeWide: avg('eyeWideLeft', 'eyeWideRight'),
            browUp: bs.browInnerUp || 0,
            browDown: avg('browDownLeft', 'browDownRight'),
            frown: avg('mouthFrownLeft', 'mouthFrownRight'),
          });
        }
      }
    } catch (e) {
      // um quadro ruim não deve parar o acompanhamento
    }
    setTimeout(() => requestAnimationFrame(() => this._loop()), 90); // ~10 vezes por segundo (economiza bateria)
  }

  // foto atual da câmera em JPEG (base64 sem prefixo), em resolução baixa para economizar
  snapshot(maxW = 512, quality = 0.6) {
    const v = this.video;
    if (!v || v.readyState < 2 || !v.videoWidth) return null;
    const w = Math.min(maxW, v.videoWidth);
    const h = Math.round((v.videoHeight / v.videoWidth) * w);
    this.canvas.width = w;
    this.canvas.height = h;
    this.canvas.getContext('2d').drawImage(v, 0, 0, w, h);
    return this.canvas.toDataURL('image/jpeg', quality).split(',')[1];
  }

  stop() {
    this.running = false;
    try { this.stream?.getTracks().forEach((t) => t.stop()); } catch {}
    this.video.srcObject = null;
  }
}
