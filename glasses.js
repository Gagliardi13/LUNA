// Óculos 3D criados por código e presos à cabeça do avatar
// (o modelo realista gratuito não vem com óculos).
import * as THREE from 'three';

function roundedRect(w, h, r) {
  const s = new THREE.Shape();
  const x = -w / 2, y = -h / 2;
  s.moveTo(x + r, y);
  s.lineTo(x + w - r, y);
  s.quadraticCurveTo(x + w, y, x + w, y + r);
  s.lineTo(x + w, y + h - r);
  s.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  s.lineTo(x + r, y + h);
  s.quadraticCurveTo(x, y + h, x, y + h - r);
  s.lineTo(x, y + r);
  s.quadraticCurveTo(x, y, x + r, y);
  return s;
}

export function addGlasses(armature, { color = 0x1b1b1f, forward = 0.021, drop = 0.004, scale = 1 } = {}) {
  const head = armature.getObjectByName('Head');
  const le = armature.getObjectByName('LeftEye');
  const re = armature.getObjectByName('RightEye');
  if (!head || !le || !re) return null;
  armature.updateWorldMatrix(true, true);

  const L = le.getWorldPosition(new THREE.Vector3());
  const R = re.getWorldPosition(new THREE.Vector3());
  const ipd = L.distanceTo(R);
  const xAxis = L.clone().sub(R).normalize(); // para o lado esquerdo dela
  const up = new THREE.Vector3(0, 1, 0);
  up.sub(xAxis.clone().multiplyScalar(up.dot(xAxis))).normalize();
  const fwd = new THREE.Vector3().crossVectors(xAxis, up).normalize();
  const center = L.clone().add(R).multiplyScalar(0.5);

  const w = ipd * 0.86 * scale, h = w * 0.6, t = w * 0.075, r = h * 0.32;
  const frameMat = new THREE.MeshStandardMaterial({ color, roughness: 0.35, metalness: 0.2 });
  const lensMat = new THREE.MeshPhysicalMaterial({
    color: 0xffffff, transparent: true, opacity: 0.12, roughness: 0.05, metalness: 0, depthWrite: false,
  });

  const g = new THREE.Group();
  g.name = 'Oculos';
  for (const side of [1, -1]) {
    const outer = roundedRect(w, h, r);
    outer.holes.push(roundedRect(w - 2 * t, h - 2 * t, Math.max(0.001, r - t)));
    const frame = new THREE.Mesh(new THREE.ExtrudeGeometry(outer, { depth: t * 0.6, bevelEnabled: false, curveSegments: 6 }), frameMat);
    frame.position.set(side * ipd / 2, 0, 0);
    frame.rotation.y = side * 0.06; // leve curvatura acompanhando o rosto
    g.add(frame);
    const lens = new THREE.Mesh(new THREE.ShapeGeometry(roundedRect(w - 2 * t, h - 2 * t, Math.max(0.001, r - t))), lensMat);
    lens.position.set(side * ipd / 2, 0, t * 0.3);
    lens.rotation.y = side * 0.06;
    lens.renderOrder = 2;
    g.add(lens);
    // haste até a orelha
    const temple = new THREE.Mesh(new THREE.BoxGeometry(t * 0.55, t * 0.7, 0.105), frameMat);
    temple.position.set(side * (ipd / 2 + w / 2 - t * 0.3), h * 0.22, -0.052);
    temple.rotation.y = -side * 0.06;
    g.add(temple);
  }
  // ponte sobre o nariz
  const gap = ipd - w;
  const bridge = new THREE.Mesh(new THREE.BoxGeometry(Math.max(0.004, gap + t), t * 0.6, t * 0.6), frameMat);
  bridge.position.set(0, h * 0.18, t * 0.3);
  g.add(bridge);

  // orienta e posiciona no mundo, depois prende na cabeça mantendo a posição
  const m = new THREE.Matrix4().makeBasis(xAxis, up, fwd);
  g.quaternion.setFromRotationMatrix(m);
  g.position.copy(center).addScaledVector(fwd, forward).addScaledVector(up, -drop);
  armature.parent ? armature.parent.add(g) : armature.add(g);
  g.updateWorldMatrix(true, true);
  head.attach(g);
  g.traverse((o) => { o.frustumCulled = false; });
  return g;
}
