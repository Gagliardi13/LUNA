// Visual da Luna: iluminação de estúdio, enquadramento de chamada de vídeo,
// óculos, cor do cabelo. Tudo num lugar só para ajustar fácil.
import * as THREE from 'three';
import { addGlasses } from './glasses.js';

export const LOOK = {
  hair: '#3d2a22',     // castanho-escuro
  exposure: 1.0,
  env: 0.32,           // força dos reflexos do ambiente (alto demais = aspecto plástico e chapado)
  ambient: 0.4,       // luz geral (baixa: deixa o volume do rosto aparecer)
  key: { color: 0xfff0e2, intensity: 5.0, pos: [-1.4, 2.0, 2.0] },   // principal, quente, de cima à esquerda
  fill: { color: 0xe6ecff, intensity: 0.9, pos: [1.6, 1.4, 1.6] },  // preenchimento suave à direita
  rim: { color: 0xd9e2ff, intensity: 5.5, pos: [0.8, 2.4, -2.0] },  // contorno por trás: separa do fundo
  view: 'head',
  cameraDistance: 1.3, // plano de chamada de vídeo: cabeça e ombros
  cameraY: 0.5,
};

export function applyLook(head, look = LOOK) {
  const r = head.renderer;
  r.toneMapping = THREE.ACESFilmicToneMapping;
  r.toneMappingExposure = look.exposure;
  head.scene.environmentIntensity = look.env;

  // troca as luzes padrão por um esquema de estúdio
  head.lightAmbient.intensity = look.ambient;
  head.lightDirect.intensity = 0;
  head.lightSpot.intensity = 0;
  const target = head.armature.getObjectByName('Head') || head.armature;
  const mk = (cfg) => {
    const l = new THREE.DirectionalLight(cfg.color, cfg.intensity);
    l.position.set(...cfg.pos);
    l.target = target;
    head.scene.add(l);
    return l;
  };
  head.lookLights = { key: mk(look.key), fill: mk(look.fill), rim: mk(look.rim) };

  // reflexos do ambiente mais fracos na pele e nos tecidos (evita aspecto plástico)
  head.armature.traverse((o) => {
    if (!o.isMesh) return;
    for (const m of Array.isArray(o.material) ? o.material : [o.material]) {
      if (!m) continue;
      if ('envMapIntensity' in m) m.envMapIntensity = /hair/i.test(o.name) ? 0.35 : 0.6;
      if (/hair/i.test(o.name) && m.color) m.color.set(look.hair);
    }
  });

  head.glasses = addGlasses(head.armature, { color: 0x050506 });
  frame(head, look);
  // reenquadra quando a tela gira ou a janela muda de tamanho
  let t;
  window.addEventListener('resize', () => { clearTimeout(t); t = setTimeout(() => frame(head, look), 250); });
}

export function setHair(head, color) {
  head.armature.traverse((o) => {
    if (!o.isMesh || !/hair/i.test(o.name)) return;
    for (const m of Array.isArray(o.material) ? o.material : [o.material]) m && m.color && m.color.set(color);
  });
}

let zoom = 0; // ajuste pedido por comando: negativo = mais perto
export function setZoom(head, z, look = LOOK) {
  zoom = z;
  frame(head, look);
}

// celular em pé precisa da câmera mais longe para caber cabeça e ombros
export function frame(head, look = LOOK) {
  const el = head.nodeAvatar;
  const aspect = el.clientWidth / Math.max(1, el.clientHeight);
  let extra = 0, dy = 0;
  if (aspect < 0.8) { extra = 1.2; dy = 0.22; }
  else if (aspect < 1.2) { extra = 0.6; dy = 0.1; }
  head.setView(look.view, { cameraDistance: Math.max(0.2, look.cameraDistance + extra + zoom), cameraY: look.cameraY + dy - zoom * 0.05 });
}
