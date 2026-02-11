import * as THREE from 'three';

/**
 * Procedural lobster mesh — adapted from openclaw-world.
 * MeshToonMaterial for stylised cel-shading look.
 */
export function createLobster(color: string): THREE.Group {
  const group = new THREE.Group();
  group.name = 'lobster';

  const baseColor = new THREE.Color(color);
  const darkColor = baseColor.clone().multiplyScalar(0.6);

  const bodyMat = new THREE.MeshToonMaterial({ color: baseColor });
  const darkMat = new THREE.MeshToonMaterial({ color: darkColor });
  const eyeMat = new THREE.MeshToonMaterial({ color: 0x111111 });
  const eyeWhiteMat = new THREE.MeshToonMaterial({ color: 0xeeeeee });

  // Body
  const body = new THREE.Mesh(new THREE.SphereGeometry(0.6, 12, 8), bodyMat);
  body.scale.set(1, 0.7, 1.6);
  body.position.set(0, 0.5, 0);
  body.castShadow = true;
  group.add(body);

  // Head
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.4, 10, 8), bodyMat);
  head.scale.set(1, 0.8, 1.1);
  head.position.set(0, 0.55, 0.85);
  head.castShadow = true;
  group.add(head);

  // Tail segments
  for (let i = 0; i < 5; i++) {
    const t = i / 5;
    const radius = 0.45 * (1 - t * 0.5);
    const seg = new THREE.Mesh(
      new THREE.SphereGeometry(radius, 8, 6),
      i % 2 === 0 ? bodyMat : darkMat,
    );
    seg.scale.set(1, 0.6, 0.9);
    seg.position.set(0, 0.35 - i * 0.05, -0.8 - i * 0.38);
    seg.castShadow = true;
    group.add(seg);
  }

  // Tail fan
  const fan = new THREE.Mesh(new THREE.SphereGeometry(0.35, 8, 6), darkMat);
  fan.scale.set(1.6, 0.2, 1);
  fan.position.set(0, 0.2, -2.7);
  fan.castShadow = true;
  group.add(fan);

  // Claws
  for (const side of [-1, 1]) {
    const clawGroup = new THREE.Group();
    clawGroup.name = side === -1 ? 'claw_left' : 'claw_right';

    const arm = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.1, 0.8, 6), bodyMat);
    arm.rotation.z = side * 0.5;
    arm.rotation.x = -0.3;
    arm.position.set(side * 0.4, 0, 0.3);
    arm.castShadow = true;
    clawGroup.add(arm);

    const forearm = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.09, 0.6, 6), bodyMat);
    forearm.position.set(side * 0.8, 0.1, 0.6);
    forearm.rotation.z = side * 0.8;
    forearm.castShadow = true;
    clawGroup.add(forearm);

    for (const half of [-1, 1]) {
      const pincer = new THREE.Mesh(new THREE.SphereGeometry(0.14, 8, 6), darkMat);
      pincer.scale.set(0.6, 0.4, 1.5);
      pincer.position.set(side * 1.1, 0.1 + half * 0.06, 0.85);
      pincer.castShadow = true;
      clawGroup.add(pincer);
    }

    clawGroup.position.set(0, 0.5, 0.3);
    group.add(clawGroup);
  }

  // Legs (4 pairs)
  for (let i = 0; i < 4; i++) {
    for (const side of [-1, 1]) {
      const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.04, 0.5, 4), darkMat);
      leg.position.set(side * (0.45 + i * 0.02), 0.15, 0.3 - i * 0.3);
      leg.rotation.z = side * 0.8;
      leg.rotation.x = -0.1 + i * 0.05;
      leg.castShadow = true;
      leg.name = `leg_${side === -1 ? 'l' : 'r'}_${i}`;
      group.add(leg);
    }
  }

  // Eye stalks
  for (const side of [-1, 1]) {
    const stalk = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.04, 0.3, 6), bodyMat);
    stalk.position.set(side * 0.18, 0.85, 1.05);
    stalk.rotation.z = side * 0.3;
    stalk.rotation.x = -0.2;
    group.add(stalk);

    const eyeWhite = new THREE.Mesh(new THREE.SphereGeometry(0.06, 8, 6), eyeWhiteMat);
    eyeWhite.position.set(side * 0.25, 0.97, 1.08);
    group.add(eyeWhite);

    const eye = new THREE.Mesh(new THREE.SphereGeometry(0.04, 8, 6), eyeMat);
    eye.position.set(side * 0.27, 0.97, 1.12);
    group.add(eye);
  }

  // Antennae
  for (const side of [-1, 1]) {
    const points: THREE.Vector3[] = [];
    for (let t = 0; t <= 1; t += 0.1) {
      points.push(new THREE.Vector3(
        side * (0.1 + t * 0.4),
        0.8 + t * 0.3 - t * t * 0.4,
        1.1 + t * 0.8,
      ));
    }
    const curve = new THREE.CatmullRomCurve3(points);
    const tubeGeo = new THREE.TubeGeometry(curve, 10, 0.015, 4, false);
    group.add(new THREE.Mesh(tubeGeo, darkMat));
  }

  group.scale.set(1.2, 1.2, 1.2);
  return group;
}

// ── Animations ───────────────────────────────────────────────────────────────

export type LobsterState = 'idle' | 'active' | 'waiting' | 'error' | 'dead';

/** Idle: sleeping — tilted on side, gentle breathing, still legs */
export function animateIdle(group: THREE.Group, time: number): void {
  // Tilted on side, resting on ground
  group.rotation.x = 0.1;
  group.rotation.z = 0.4 + Math.sin(time * 0.8) * 0.03; // gentle breathing sway
  group.position.y += Math.sin(time * 1.2) * 0.008; // subtle breathing rise

  // Legs relaxed and still
  group.children.forEach((child) => {
    if (child.name.startsWith('leg_')) {
      child.rotation.x = 0.1; // tucked in
    }
  });

  // Claws resting, slight breathing movement
  const lc = group.getObjectByName('claw_left');
  const rc = group.getObjectByName('claw_right');
  if (lc) {
    lc.rotation.x = 0.2;
    lc.rotation.z = 0.3 + Math.sin(time * 0.8) * 0.02;
  }
  if (rc) {
    rc.rotation.x = 0.2;
    rc.rotation.z = -0.3 + Math.sin(time * 0.8 + Math.PI) * 0.02;
  }
}

/** Active: frantic labor — hunched, scared, working hard */
export function animateActive(group: THREE.Group, time: number): void {
  group.rotation.x = 0.5 + Math.sin(time * 8) * 0.12;
  group.rotation.z = Math.sin(time * 5) * 0.08;
  group.position.y += Math.abs(Math.sin(time * 10)) * 0.035;
  group.position.x += Math.sin(time * 20) * 0.006;
  group.position.z += Math.cos(time * 16) * 0.004;

  group.children.forEach((child) => {
    if (child.name.startsWith('leg_')) {
      const idx = parseInt(child.name.split('_')[2], 10);
      const side = child.name.includes('_l_') ? -1 : 1;
      child.rotation.x = Math.sin(time * 16 + idx * 1.5 + side * Math.PI) * 0.7;
      child.rotation.z = side * (0.8 + Math.sin(time * 12 + idx) * 0.2);
    }
  });

  const lc = group.getObjectByName('claw_left');
  const rc = group.getObjectByName('claw_right');
  if (lc) {
    lc.rotation.x = 0.8 + Math.sin(time * 8) * 0.35;
    lc.rotation.z = 0.3 + Math.sin(time * 6) * 0.2;
    lc.position.y = Math.abs(Math.sin(time * 10)) * 0.08;
  }
  if (rc) {
    rc.rotation.x = 0.8 + Math.sin(time * 8 + Math.PI * 0.5) * 0.35;
    rc.rotation.z = -0.3 + Math.sin(time * 6 + Math.PI) * 0.2;
    rc.position.y = Math.abs(Math.sin(time * 10 + Math.PI * 0.7)) * 0.08;
  }
}

/** Waiting: nervous — working but glancing around, fidgety */
export function animateWaiting(group: THREE.Group, time: number): void {
  group.rotation.x = 0.3 + Math.sin(time * 4) * 0.06;
  // Occasional nervous glance
  const lookPhase = (time * 0.7) % 3.0;
  const lookAngle = lookPhase < 0.4 ? Math.sin(lookPhase / 0.4 * Math.PI) * 0.35 :
                    lookPhase < 1.8 ? 0 :
                    lookPhase < 2.2 ? -Math.sin((lookPhase - 1.8) / 0.4 * Math.PI) * 0.3 : 0;
  group.rotation.y += lookAngle;
  group.rotation.z = Math.sin(time * 3) * 0.04;
  group.position.y += Math.abs(Math.sin(time * 5)) * 0.02;
  group.position.x += Math.sin(time * 12) * 0.003;

  group.children.forEach((child) => {
    if (child.name.startsWith('leg_')) {
      const idx = parseInt(child.name.split('_')[2], 10);
      const side = child.name.includes('_l_') ? -1 : 1;
      child.rotation.x = Math.sin(time * 8 + idx * 1.3 + side * Math.PI) * 0.5;
    }
  });

  const lc = group.getObjectByName('claw_left');
  const rc = group.getObjectByName('claw_right');
  if (lc) {
    lc.rotation.x = 0.6 + Math.sin(time * 5) * 0.25;
    lc.rotation.z = 0.2 + Math.sin(time * 3.5) * 0.12;
  }
  if (rc) {
    rc.rotation.z = -0.3 + Math.sin(time * 4) * 0.18;
    rc.rotation.x = 0.3 + Math.sin(time * 3) * 0.15 + (lookAngle !== 0 ? 0.3 : 0);
  }
}

/** Error: sick wobble — upright but swaying/stumbling, something wrong but alive */
export function animateError(group: THREE.Group, time: number): void {
  // Unsteady, feverish sway — visibly distressed
  group.rotation.x = 0.2 + Math.sin(time * 4) * 0.15;
  group.rotation.z = Math.sin(time * 3.5) * 0.18 + Math.sin(time * 7) * 0.08;
  group.position.y += Math.abs(Math.sin(time * 6)) * 0.02;
  // Stumbling sideways
  group.position.x += Math.sin(time * 4.5) * 0.025;
  group.position.z += Math.cos(time * 3.2) * 0.01;

  // Legs twitching erratically
  group.children.forEach((child) => {
    if (child.name.startsWith('leg_')) {
      const idx = parseInt(child.name.split('_')[2], 10);
      const side = child.name.includes('_l_') ? -1 : 1;
      child.rotation.x = Math.sin(time * 7 + idx * 1.8 + side * Math.PI) * 0.45;
    }
  });

  // Claws drooping but trembling
  const lc = group.getObjectByName('claw_left');
  const rc = group.getObjectByName('claw_right');
  if (lc) {
    lc.rotation.x = 0.7 + Math.sin(time * 5) * 0.18;
    lc.rotation.z = 0.4 + Math.sin(time * 3.5) * 0.12;
  }
  if (rc) {
    rc.rotation.x = 0.7 + Math.sin(time * 5 + Math.PI * 0.3) * 0.18;
    rc.rotation.z = -0.4 + Math.sin(time * 3.5 + Math.PI) * 0.12;
  }
}

/** Dead: flipped on back, legs twitching — session exited/killed */
export function animateDead(group: THREE.Group, time: number): void {
  group.rotation.x = Math.PI;
  group.position.y += 0.3;

  // Twitchy legs
  group.children.forEach((child) => {
    if (child.name.startsWith('leg_')) {
      const idx = parseInt(child.name.split('_')[2], 10);
      child.rotation.x = Math.sin(time * 3 + idx * 2) * 0.3;
    }
  });

  // Limp claws
  const lc = group.getObjectByName('claw_left');
  const rc = group.getObjectByName('claw_right');
  if (lc) lc.rotation.z = 0.5;
  if (rc) rc.rotation.z = -0.5;
}

// ── Sweat particles ─────────────────────────────────────────────────────────

/** Create sweat particle sprites — small, subtle drops */
export function createSweatParticles(): THREE.Group {
  const sweatGroup = new THREE.Group();
  sweatGroup.name = 'sweat-particles';

  const canvas = document.createElement('canvas');
  canvas.width = 16;
  canvas.height = 16;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#7ec8ff';
  ctx.beginPath();
  ctx.moveTo(8, 2);
  ctx.quadraticCurveTo(14, 9, 8, 14);
  ctx.quadraticCurveTo(2, 9, 8, 2);
  ctx.fill();
  ctx.fillStyle = 'rgba(255,255,255,0.5)';
  ctx.beginPath();
  ctx.arc(6, 7, 1.5, 0, Math.PI * 2);
  ctx.fill();

  const texture = new THREE.CanvasTexture(canvas);
  const spriteMat = new THREE.SpriteMaterial({ map: texture, transparent: true, opacity: 0 });

  for (let i = 0; i < 5; i++) {
    const sprite = new THREE.Sprite(spriteMat.clone());
    sprite.scale.set(0.12, 0.16, 1);
    sprite.name = `sweat_${i}`;
    sprite.visible = false;
    sweatGroup.add(sprite);
  }

  return sweatGroup;
}

/** Animate sweat — only active lobsters show subtle drops */
export function animateSweatParticles(sweatGroup: THREE.Group, time: number, state: LobsterState): void {
  const count = sweatGroup.children.length;

  // Only active lobsters sweat (not idle, waiting, error, or dead)
  if (state !== 'active') {
    for (let i = 0; i < count; i++) (sweatGroup.children[i] as THREE.Sprite).visible = false;
    return;
  }

  const speed = 1.5;
  const visibleCount = 4;

  for (let i = 0; i < count; i++) {
    const sprite = sweatGroup.children[i] as THREE.Sprite;
    if (i >= visibleCount) { sprite.visible = false; continue; }

    sprite.visible = true;
    const cycle = ((time * speed + i / visibleCount) % 1.0);
    const angle = (i / visibleCount) * Math.PI * 2;
    const spreadX = Math.cos(angle) * 0.35;
    const spreadZ = Math.sin(angle) * 0.2;

    sprite.position.set(
      spreadX + Math.sin(time * 3 + i * 2.5) * 0.06,
      0.8 + cycle * 1.2,
      spreadZ,
    );

    const mat = sprite.material as THREE.SpriteMaterial;
    if (cycle < 0.1) {
      mat.opacity = cycle / 0.1;
    } else if (cycle > 0.75) {
      mat.opacity = (1 - cycle) / 0.25;
    } else {
      mat.opacity = 1.0;
    }
    mat.opacity *= 0.55;

    const s = 0.1 + cycle * 0.08;
    sprite.scale.set(s, s * 1.3, 1);
  }
}

/** Create the human whip-master figure — proper ~1:6 head-body ratio, stocky build */
export function createWhipMaster(): THREE.Group {
  const group = new THREE.Group();
  group.name = 'whip-master';

  const skinMat = new THREE.MeshToonMaterial({ color: 0xd4a574 });
  const clothMat = new THREE.MeshToonMaterial({ color: 0x1a1a2e });
  const beltMat = new THREE.MeshToonMaterial({ color: 0x3d2010 });
  const bootMat = new THREE.MeshToonMaterial({ color: 0x2d1810 });
  const whipMat = new THREE.MeshToonMaterial({ color: 0x3d2010 });

  // ── Lower body ──
  // Boots (y: 0 → 0.45)
  for (const side of [-1, 1]) {
    const boot = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.18, 0.45, 8), bootMat);
    boot.position.set(side * 0.22, 0.22, 0);
    boot.castShadow = true;
    group.add(boot);
  }

  // Upper legs (y: 0.45 → 1.15)
  for (const side of [-1, 1]) {
    const thigh = new THREE.Mesh(new THREE.CylinderGeometry(0.14, 0.16, 0.7, 8), clothMat);
    thigh.position.set(side * 0.22, 0.8, 0);
    thigh.castShadow = true;
    group.add(thigh);
  }

  // Lower legs / shins (y: 1.15 → 1.55)
  for (const side of [-1, 1]) {
    const shin = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.14, 0.5, 8), clothMat);
    shin.position.set(side * 0.22, 1.35, 0);
    shin.castShadow = true;
    group.add(shin);
  }

  // ── Torso ── (y: 1.5 → 2.65)
  // Hips / belt area
  const hips = new THREE.Mesh(new THREE.CylinderGeometry(0.38, 0.42, 0.35, 8), clothMat);
  hips.position.y = 1.7;
  hips.castShadow = true;
  group.add(hips);

  // Belt
  const belt = new THREE.Mesh(new THREE.CylinderGeometry(0.43, 0.43, 0.08, 10), beltMat);
  belt.position.y = 1.55;
  group.add(belt);

  // Chest (wider at shoulders)
  const chest = new THREE.Mesh(new THREE.CylinderGeometry(0.42, 0.38, 0.7, 8), clothMat);
  chest.position.y = 2.2;
  chest.castShadow = true;
  group.add(chest);

  // Shoulders (broad)
  const shoulders = new THREE.Mesh(new THREE.CylinderGeometry(0.48, 0.44, 0.2, 8), clothMat);
  shoulders.position.y = 2.6;
  shoulders.castShadow = true;
  group.add(shoulders);

  // ── Neck + Head ──
  const neck = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.14, 0.2, 8), skinMat);
  neck.position.y = 2.8;
  group.add(neck);

  // Head (sphere r=0.3, head top at ~3.25)
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.3, 12, 10), skinMat);
  head.scale.set(1, 1.05, 0.95);
  head.position.y = 3.1;
  head.castShadow = true;
  group.add(head);

  // Hat (cowboy/slavedriver)
  const hatBrim = new THREE.Mesh(new THREE.CylinderGeometry(0.55, 0.55, 0.05, 14), clothMat);
  hatBrim.position.y = 3.4;
  group.add(hatBrim);
  const hatTop = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.28, 0.35, 10), clothMat);
  hatTop.position.y = 3.58;
  group.add(hatTop);

  // Eyes (menacing red)
  for (const side of [-1, 1]) {
    const eye = new THREE.Mesh(new THREE.SphereGeometry(0.045, 6, 6), new THREE.MeshToonMaterial({ color: 0xff2222 }));
    eye.position.set(side * 0.12, 3.15, 0.27);
    group.add(eye);
  }

  // ── Arms ──
  // Left arm (at side, slightly bent)
  const leftUpperArm = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.1, 0.55, 6), clothMat);
  leftUpperArm.position.set(-0.55, 2.35, 0);
  leftUpperArm.rotation.z = 0.15;
  leftUpperArm.castShadow = true;
  group.add(leftUpperArm);

  const leftForearm = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.09, 0.5, 6), skinMat);
  leftForearm.position.set(-0.6, 1.85, 0.05);
  leftForearm.rotation.z = 0.1;
  leftForearm.castShadow = true;
  group.add(leftForearm);

  // Right arm (raised with whip) — uses a group for animation
  const rightArmGroup = new THREE.Group();
  rightArmGroup.name = 'whip-arm';

  const rightUpperArm = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.1, 0.55, 6), clothMat);
  rightUpperArm.position.set(0, -0.28, 0);
  rightUpperArm.castShadow = true;
  rightArmGroup.add(rightUpperArm);

  const rightForearm = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.09, 0.45, 6), skinMat);
  rightForearm.position.set(0, -0.6, 0);
  rightForearm.castShadow = true;
  rightArmGroup.add(rightForearm);

  // Whip — long curved tube from hand
  const whipPoints: THREE.Vector3[] = [];
  for (let t = 0; t <= 1; t += 0.04) {
    whipPoints.push(new THREE.Vector3(
      t * 0.6 + Math.sin(t * Math.PI * 2) * 0.35,
      -0.85 - t * 2.5,
      Math.sin(t * Math.PI) * 1.0,
    ));
  }
  const whipCurve = new THREE.CatmullRomCurve3(whipPoints);
  const whipThick = 0.025;
  const whipGeo = new THREE.TubeGeometry(whipCurve, 24, whipThick, 5, false);
  const whip = new THREE.Mesh(whipGeo, whipMat);
  whip.name = 'whip';
  rightArmGroup.add(whip);

  rightArmGroup.position.set(0.55, 2.65, 0.1);
  rightArmGroup.rotation.z = -0.6;
  rightArmGroup.rotation.x = -0.3;
  group.add(rightArmGroup);

  return group;
}

/** Animate the whip master — steady, deliberate cracking with body follow-through */
export function animateWhipMaster(group: THREE.Group, time: number, hasActiveSession: boolean): void {
  const arm = group.getObjectByName('whip-arm');
  if (!arm) return;

  if (hasActiveSession) {
    // Deliberate whip cycle: wind-up → crack → follow-through
    const rate = 2.0;
    const t = (time * rate) % 1.0;
    let swing: number;
    let crackIntensity = 0;

    if (t < 0.4) {
      const p = t / 0.4;
      swing = -1.0 + p * p * 0.3;
    } else if (t < 0.7) {
      const p = (t - 0.4) / 0.3;
      const easeOut = 1 - (1 - p) * (1 - p);
      swing = -0.7 + easeOut * 1.7;
      crackIntensity = p < 0.5 ? p * 2 : (1 - p) * 2;
    } else {
      const p = (t - 0.7) / 0.3;
      swing = 1.0 - p * 2.0;
    }

    arm.rotation.z = swing * 1.4;
    arm.rotation.x = -1.5 + (swing + 1.0) * 0.6;

    group.rotation.y += swing * 0.1;

    if (t < 0.4) {
      group.rotation.x += -(t / 0.4) * 0.08;
    } else if (t < 0.7) {
      const p = (t - 0.4) / 0.3;
      group.rotation.x += -0.08 + p * 0.24;
    } else {
      const p = (t - 0.7) / 0.3;
      group.rotation.x += 0.16 - p * 0.16;
    }

    group.rotation.z += swing * 0.08;

    const stompPhase = t > 0.35 && t < 0.6;
    const stompHeight = stompPhase ? Math.sin(((t - 0.35) / 0.25) * Math.PI) * 0.08 : 0;
    group.position.y += stompHeight;
    group.position.z += crackIntensity * 0.04;
  } else {
    arm.rotation.z = -0.5 + Math.sin(time * 0.8) * 0.06;
    arm.rotation.x = -0.15 + Math.sin(time * 0.5) * 0.04;
    group.rotation.z += Math.sin(time * 0.5) * 0.015;
    group.rotation.x += Math.sin(time * 0.4) * 0.01;
  }
}
