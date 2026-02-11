import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import {
  createLobster,
  createWhipMaster,
  animateIdle,
  animateActive,
  animateWaiting,
  animateError,
  animateDead,
  animateWhipMaster,
  createSweatParticles,
  animateSweatParticles,
  type LobsterState,
} from './lobster.js';
import type { WsClient } from './ws-client.js';

interface SessionData {
  id: string;
  name: string;
  group: string;
  status: string;
  detailedState?: string;
  lastActivityAt: string;
}

interface LobsterEntry {
  sessionId: string;
  group: THREE.Group;
  sweatGroup: THREE.Group;
  state: LobsterState;
  basePosition: THREE.Vector3;
  baseRotationY: number;
  label: HTMLDivElement;
}

const LOBSTER_COLORS = [
  '#e63946', '#f4845f', '#f7b267', '#a8dadc',
  '#457b9d', '#1d3557', '#6a4c93', '#2a9d8f',
  '#e9c46a', '#f4a261', '#264653', '#e76f51',
];

const ACTIVITY_THRESHOLD_MS = 3000;

const GRASS_COUNT = 8000;
const GRASS_SPREAD = 80;

export class LobsterScene {
  private renderer: THREE.WebGLRenderer;
  private scene: THREE.Scene;
  private camera: THREE.PerspectiveCamera;
  private controls: OrbitControls;
  private container: HTMLElement;
  private labelContainer: HTMLElement;
  private lobsters = new Map<string, LobsterEntry>();
  private whipMaster: THREE.Group;
  private clock = new THREE.Clock();
  private animFrameId = 0;
  private ws: WsClient;
  private colorIndex = 0;
  private sessions: SessionData[] = [];
  private unsubHandlers: (() => void)[] = [];
  private raycaster = new THREE.Raycaster();
  private pointer = new THREE.Vector2();

  // Grass (GPU-driven wind via shader)
  private grassMaterial: THREE.ShaderMaterial | null = null;

  // Callback when a lobster is clicked
  onLobsterClick: ((sessionId: string) => void) | null = null;

  constructor(container: HTMLElement, labelContainer: HTMLElement, ws: WsClient) {
    this.container = container;
    this.labelContainer = labelContainer;
    this.ws = ws;

    // Renderer — tone mapping for richer colors
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    this.renderer.setPixelRatio(window.devicePixelRatio);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.1;
    container.appendChild(this.renderer.domElement);

    // Scene with sky gradient background
    this.scene = new THREE.Scene();
    this.scene.fog = new THREE.FogExp2(0xc8dfe8, 0.01);
    this.scene.background = this.createSkyGradient();

    // Camera — positioned to see overseer at back, workers in front
    this.camera = new THREE.PerspectiveCamera(60, 1, 0.1, 200);
    this.camera.position.set(14, 10, 6);

    // Controls (touch-friendly)
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.minDistance = 5;
    this.controls.maxDistance = 40;
    this.controls.maxPolarAngle = Math.PI * 0.45;
    this.controls.target.set(0, 1, 4);
    this.controls.touches = {
      ONE: THREE.TOUCH.ROTATE,
      TWO: THREE.TOUCH.DOLLY_PAN,
    };

    // Environment
    this.setupLights();
    this.setupGround();
    this.setupGrass();
    this.setupRocks();

    // Whip master at the back — overseer position watching the workers
    this.whipMaster = createWhipMaster();
    this.whipMaster.position.set(-2, 0, -4);
    this.whipMaster.rotation.y = Math.PI * 0.1;
    this.scene.add(this.whipMaster);

    // Click/tap detection on canvas
    this.renderer.domElement.addEventListener('pointerup', (e) => this.onPointerUp(e));

    // Label clicks (skip dead lobsters — session exited)
    this.labelContainer.addEventListener('click', (e) => {
      const label = (e.target as HTMLElement).closest('.lobster-label') as HTMLElement | null;
      if (!label) return;
      const sid = label.dataset.sid;
      if (!sid || !this.onLobsterClick) return;
      const entry = this.lobsters.get(sid);
      if (entry?.state === 'dead') return;
      this.onLobsterClick(sid);
    });

    // Resize — use ResizeObserver to catch container visibility changes (not just window resize)
    this.resizeObserver = new ResizeObserver(() => this.handleResize());
    this.resizeObserver.observe(this.container);
    window.addEventListener('resize', () => this.handleResize());

    // WebSocket
    this.setupWsListeners();
  }

  private resizeObserver: ResizeObserver;

  /** Deterministic pseudo-random from seed (0..1) */
  private rand(seed: number): number {
    const x = Math.sin(seed * 127.1 + 311.7) * 43758.5453;
    return x - Math.floor(x);
  }

  private onPointerUp(e: PointerEvent): void {
    if (!this.onLobsterClick) return;

    const rect = this.renderer.domElement.getBoundingClientRect();
    this.pointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    this.pointer.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;

    this.raycaster.setFromCamera(this.pointer, this.camera);

    for (const entry of this.lobsters.values()) {
      // Dead lobsters are not clickable (session exited)
      if (entry.state === 'dead') continue;
      const hits = this.raycaster.intersectObjects(entry.group.children, true);
      if (hits.length > 0) {
        this.onLobsterClick(entry.sessionId);
        return;
      }
    }
  }

  // ── Sky ──────────────────────────────────────────────────────────────────────

  private createSkyGradient(): THREE.Texture {
    const canvas = document.createElement('canvas');
    canvas.width = 2;
    canvas.height = 256;
    const ctx = canvas.getContext('2d')!;
    const grad = ctx.createLinearGradient(0, 0, 0, 256);
    grad.addColorStop(0, '#3a7bd5');
    grad.addColorStop(0.4, '#6db3f2');
    grad.addColorStop(0.7, '#a3d5f7');
    grad.addColorStop(0.9, '#d4ecf9');
    grad.addColorStop(1.0, '#eef5dc');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, 2, 256);
    const tex = new THREE.CanvasTexture(canvas);
    tex.mapping = THREE.EquirectangularReflectionMapping;
    return tex;
  }

  // ── Lights ───────────────────────────────────────────────────────────────────

  private setupLights(): void {
    this.scene.add(new THREE.HemisphereLight(0x7eb8d8, 0xb89f78, 0.5));
    this.scene.add(new THREE.AmbientLight(0xffffff, 0.15));

    const sun = new THREE.DirectionalLight(0xfff0d4, 2.5);
    sun.position.set(10, 20, 8);
    sun.castShadow = true;
    sun.shadow.mapSize.setScalar(2048);
    sun.shadow.camera.near = 0.5;
    sun.shadow.camera.far = 80;
    sun.shadow.bias = -0.001;
    const s = 25;
    sun.shadow.camera.left = -s;
    sun.shadow.camera.right = s;
    sun.shadow.camera.top = s;
    sun.shadow.camera.bottom = -s;
    this.scene.add(sun);

    const rim = new THREE.DirectionalLight(0x8ecae6, 0.6);
    rim.position.set(-8, 10, -6);
    this.scene.add(rim);
  }

  // ── Ground (procedural soil texture) ─────────────────────────────────────────

  private createGroundTexture(): THREE.CanvasTexture {
    const size = 512;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d')!;

    // Base soil color
    ctx.fillStyle = '#a89060';
    ctx.fillRect(0, 0, size, size);

    // Layer noise-like patches for soil variation
    const colors = ['#b8a47a', '#9e8a5e', '#c4b088', '#8a7a50', '#b09868', '#a09058'];
    for (let i = 0; i < 3000; i++) {
      const x = Math.random() * size;
      const y = Math.random() * size;
      const r = 1 + Math.random() * 6;
      ctx.globalAlpha = 0.15 + Math.random() * 0.2;
      ctx.fillStyle = colors[Math.floor(Math.random() * colors.length)];
      ctx.beginPath();
      ctx.ellipse(x, y, r, r * (0.6 + Math.random() * 0.8), Math.random() * Math.PI, 0, Math.PI * 2);
      ctx.fill();
    }

    // Darker cracks / dirt lines
    ctx.globalAlpha = 0.08;
    ctx.strokeStyle = '#5a4a30';
    ctx.lineWidth = 1;
    for (let i = 0; i < 80; i++) {
      const x = Math.random() * size;
      const y = Math.random() * size;
      ctx.beginPath();
      ctx.moveTo(x, y);
      let cx = x, cy = y;
      for (let j = 0; j < 4; j++) {
        cx += (Math.random() - 0.5) * 30;
        cy += (Math.random() - 0.5) * 30;
        ctx.lineTo(cx, cy);
      }
      ctx.stroke();
    }

    // Scattered pebble dots
    ctx.globalAlpha = 0.12;
    for (let i = 0; i < 400; i++) {
      const x = Math.random() * size;
      const y = Math.random() * size;
      const r = 0.5 + Math.random() * 2;
      ctx.fillStyle = Math.random() > 0.5 ? '#7a7060' : '#c0b090';
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fill();
    }

    ctx.globalAlpha = 1;
    const tex = new THREE.CanvasTexture(canvas);
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.repeat.set(6, 6);
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  }

  private setupGround(): void {
    const tex = this.createGroundTexture();
    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(80, 80),
      new THREE.MeshStandardMaterial({ map: tex, roughness: 0.92, metalness: 0.01 }),
    );
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true;
    this.scene.add(ground);
  }

  // ── Grass (GPU-driven InstancedBufferGeometry + ShaderMaterial) ──────────────
  //
  // Wind animation runs entirely in the vertex shader — zero CPU per frame.
  // Multi-segment blade geometry bends smoothly (tips curve, base stays planted).

  private setupGrass(): void {
    // ── Blade geometry: 5 segments for smooth wind bending ──
    const SEGMENTS = 5;
    const verts: number[] = [];
    const uvs: number[] = [];
    const indices: number[] = [];

    for (let i = 0; i <= SEGMENTS; i++) {
      const t = i / SEGMENTS;                       // 0 at base, 1 at tip
      const w = 0.05 * (1 - t * 0.88);              // taper toward tip
      const y = t * 0.9;
      const z = t * t * 0.06;                       // slight forward curve
      verts.push(-w, y, z);                          // left vertex
      verts.push( w, y, z);                          // right vertex
      uvs.push(0, t);
      uvs.push(1, t);
    }
    for (let i = 0; i < SEGMENTS; i++) {
      const b = i * 2;
      indices.push(b, b + 1, b + 2, b + 1, b + 3, b + 2);
    }

    // ── InstancedBufferGeometry: share blade, per-instance attrs ──
    const geo = new THREE.InstancedBufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    geo.setIndex(indices);

    const offsets = new Float32Array(GRASS_COUNT * 3);
    const scales  = new Float32Array(GRASS_COUNT * 2);
    const rots    = new Float32Array(GRASS_COUNT);
    const colors  = new Float32Array(GRASS_COUNT * 3);

    const greens: [number, number, number][] = [
      [0.24, 0.48, 0.18], [0.29, 0.54, 0.24], [0.35, 0.60, 0.30],
      [0.42, 0.67, 0.33], [0.18, 0.42, 0.13], [0.47, 0.72, 0.35],
    ];

    for (let i = 0; i < GRASS_COUNT; i++) {
      offsets[i * 3]     = (this.rand(i * 3) - 0.5) * GRASS_SPREAD;
      offsets[i * 3 + 1] = 0;
      offsets[i * 3 + 2] = (this.rand(i * 3 + 1) - 0.5) * GRASS_SPREAD;
      scales[i * 2]      = 0.7 + this.rand(i * 3 + 2) * 0.6;   // width
      scales[i * 2 + 1]  = 0.8 + this.rand(i * 5 + 2) * 1.5;   // height
      rots[i]            = this.rand(i * 7) * Math.PI * 2;
      const c = greens[Math.floor(this.rand(i * 13) * greens.length)];
      colors[i * 3]     = c[0];
      colors[i * 3 + 1] = c[1];
      colors[i * 3 + 2] = c[2];
    }

    geo.setAttribute('aOffset',   new THREE.InstancedBufferAttribute(offsets, 3));
    geo.setAttribute('aScale',    new THREE.InstancedBufferAttribute(scales, 2));
    geo.setAttribute('aRotation', new THREE.InstancedBufferAttribute(rots, 1));
    geo.setAttribute('aColor',    new THREE.InstancedBufferAttribute(colors, 3));

    // ── ShaderMaterial: vertex-driven wind + simple lit fragment ──
    const mat = new THREE.ShaderMaterial({
      uniforms: {
        uTime:   { value: 0 },
        uSunDir: { value: new THREE.Vector3(10, 20, 8).normalize() },
        uFogColor:   { value: new THREE.Color(0xc8dfe8) },
        uFogDensity: { value: 0.012 },
      },
      vertexShader: /* glsl */ `
        attribute vec3  aOffset;
        attribute vec2  aScale;
        attribute float aRotation;
        attribute vec3  aColor;

        uniform float uTime;

        varying vec3  vColor;
        varying float vHeight;
        varying vec3  vWorldPos;

        void main() {
          // Scale blade
          vec3 pos = position;
          pos.x *= aScale.x;
          pos.y *= aScale.y;
          pos.z *= aScale.x;

          // Rotate around Y
          float c = cos(aRotation), s = sin(aRotation);
          float rx = pos.x * c - pos.z * s;
          float rz = pos.x * s + pos.z * c;
          pos.x = rx;
          pos.z = rz;

          // ── Wind (height² influence — base stays planted, tip sways) ──
          float h = uv.y;
          float windPower = h * h;

          vec3 wb = aOffset; // world base for spatial variation
          // Primary sway — large slow wave
          float w1 = sin(wb.x * 0.25 + uTime * 1.6 + wb.z * 0.18) * 0.18;
          // Secondary cross-wind
          float w2 = cos(wb.x * 0.15 + uTime * 1.1 + wb.z * 0.32) * 0.10;
          // High-freq rustling detail
          float w3 = sin(wb.x * 0.6 + uTime * 3.0 + wb.z * 0.5) * 0.035;
          // Occasional gust (slow modulation)
          float gust = max(sin(uTime * 0.4 + wb.x * 0.05) * 0.5 + 0.5, 0.0);
          float gustStr = gust * sin(wb.x * 0.3 + uTime * 2.2 + wb.z * 0.2) * 0.12;

          pos.x += (w1 + w2 + w3 + gustStr) * windPower;
          pos.z += (w2 * 0.6 + w3 * 0.3) * windPower;

          // Place in world
          pos += aOffset;

          vColor    = aColor;
          vHeight   = h;
          vWorldPos = pos;

          gl_Position = projectionMatrix * modelViewMatrix * vec4(pos, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        uniform vec3  uSunDir;
        uniform vec3  uFogColor;
        uniform float uFogDensity;

        varying vec3  vColor;
        varying float vHeight;
        varying vec3  vWorldPos;

        void main() {
          // Height-based brightness: dark at root, bright at tip
          float brightness = 0.55 + vHeight * 0.45;
          // Fake sun-facing factor
          float sun = max(dot(vec3(0.0, 0.7, 0.3), uSunDir), 0.0) * 0.35 + 0.65;
          vec3 color = vColor * brightness * sun;

          // Exp² fog matching scene fog
          float dist = length(vWorldPos.xz);
          float fogFactor = 1.0 - exp(-uFogDensity * uFogDensity * dist * dist);
          color = mix(color, uFogColor, clamp(fogFactor, 0.0, 1.0));

          gl_FragColor = vec4(color, 1.0);
        }
      `,
      side: THREE.DoubleSide,
    });

    const mesh = new THREE.Mesh(geo, mat);
    mesh.frustumCulled = false;
    this.scene.add(mesh);
    this.grassMaterial = mat;
  }

  // ── Rocks (InstancedMesh) ────────────────────────────────────────────────────

  private setupRocks(): void {
    const geo = new THREE.DodecahedronGeometry(1, 0); // low-poly rock
    const mat = new THREE.MeshStandardMaterial({ color: 0x8a8578, roughness: 0.9, metalness: 0.05 });

    const count = 35;
    const mesh = new THREE.InstancedMesh(geo, mat, count);
    mesh.castShadow = true;
    mesh.receiveShadow = true;

    const dummy = new THREE.Object3D();
    const color = new THREE.Color();
    const rockColors = [0x8a8578, 0x7a7568, 0x9a9588, 0x6b655a];

    for (let i = 0; i < count; i++) {
      const x = (this.rand(i * 5 + 200) - 0.5) * 38;
      const z = (this.rand(i * 5 + 201) - 0.5) * 38;
      const scale = 0.15 + this.rand(i * 5 + 202) * 0.35;

      dummy.position.set(x, scale * 0.3, z);
      // Squashed and randomized proportions
      dummy.scale.set(
        scale * (0.8 + this.rand(i * 5 + 203) * 0.5),
        scale * (0.3 + this.rand(i * 5 + 204) * 0.4),
        scale * (0.8 + this.rand(i * 5 + 205) * 0.5),
      );
      dummy.rotation.set(
        this.rand(i * 5 + 206) * 0.3,
        this.rand(i * 5 + 207) * Math.PI * 2,
        this.rand(i * 5 + 208) * 0.3,
      );
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);

      color.set(rockColors[Math.floor(this.rand(i * 11 + 209) * rockColors.length)]);
      mesh.setColorAt(i, color);
    }

    mesh.instanceMatrix.needsUpdate = true;
    mesh.instanceColor!.needsUpdate = true;
    this.scene.add(mesh);
  }

  // ── WebSocket ────────────────────────────────────────────────────────────────

  private setupWsListeners(): void {
    this.unsubHandlers.push(
      this.ws.on('sessions', (msg) => { this.sessions = msg.sessions; this.syncLobsters(); }),
      this.ws.on('session:created', (msg) => { this.sessions.push(msg.session); this.syncLobsters(); }),
      this.ws.on('session:exited', (msg) => {
        const s = this.sessions.find((s) => s.id === msg.sessionId);
        if (s) s.status = 'exited';
      }),
      this.ws.on('output', (msg) => {
        const s = this.sessions.find((s) => s.id === msg.sessionId);
        if (s) s.lastActivityAt = new Date().toISOString();
      }),
      this.ws.on('session:stateChanged', (msg) => {
        const s = this.sessions.find((s) => s.id === msg.sessionId);
        if (s) s.detailedState = msg.detailedState;
      }),
    );
  }

  initSessions(sessions: SessionData[]): void {
    this.sessions = sessions;
    this.syncLobsters();
  }

  // ── Lobster management ───────────────────────────────────────────────────────

  private syncLobsters(): void {
    const currentIds = new Set(this.sessions.map((s) => s.id));

    for (const [id, entry] of this.lobsters) {
      if (!currentIds.has(id)) {
        this.scene.remove(entry.group);
        entry.label.remove();
        this.lobsters.delete(id);
      }
    }

    for (const s of this.sessions) {
      if (!this.lobsters.has(s.id)) this.addLobster(s);
    }

    this.positionLobstersInField();
    this.updateLobsterStates();
  }

  private addLobster(session: SessionData): void {
    const color = LOBSTER_COLORS[this.colorIndex++ % LOBSTER_COLORS.length];
    const group = createLobster(color);
    this.scene.add(group);

    const sweatGroup = createSweatParticles();
    group.add(sweatGroup);

    const label = document.createElement('div');
    label.className = 'lobster-label';
    label.dataset.sid = session.id;
    label.textContent = session.name;
    this.labelContainer.append(label);

    this.lobsters.set(session.id, {
      sessionId: session.id,
      group,
      sweatGroup,
      state: 'idle',
      basePosition: new THREE.Vector3(),
      baseRotationY: 0,
      label,
    });
  }

  private positionLobstersInField(): void {
    if (this.lobsters.size === 0) return;

    const MAX_PER_ROW = 8;

    // Group lobsters by their session group name, preserving order of first appearance
    const groupOrder: string[] = [];
    const groupEntries = new Map<string, LobsterEntry[]>();
    for (const session of this.sessions) {
      const entry = this.lobsters.get(session.id);
      if (!entry) continue;
      if (!groupEntries.has(session.group)) {
        groupEntries.set(session.group, []);
        groupOrder.push(session.group);
      }
      groupEntries.get(session.group)!.push(entry);
    }

    // Build rows: split each group into chunks of MAX_PER_ROW
    const rows: LobsterEntry[][] = [];
    for (const groupName of groupOrder) {
      const entries = groupEntries.get(groupName)!;
      for (let i = 0; i < entries.length; i += MAX_PER_ROW) {
        rows.push(entries.slice(i, i + MAX_PER_ROW));
      }
    }

    // Ground bounds: 80x80 centered at origin, leave margin for lobster size
    const GROUND_HALF = 35;
    const Z_START = 3;

    // Dynamic spacing: shrink to fit within ground bounds
    const spacingX = Math.min(3.2, (GROUND_HALF * 2) / MAX_PER_ROW);
    const spacingZ = Math.min(3.5, (GROUND_HALF - Z_START) / Math.max(rows.length, 1));

    let globalIdx = 0;

    for (let rowIndex = 0; rowIndex < rows.length; rowIndex++) {
      const row = rows[rowIndex];
      const z = Z_START + rowIndex * spacingZ;
      const xOffset = -(row.length - 1) * spacingX * 0.5;
      const rowStagger = rowIndex % 2 === 1 ? spacingX * 0.35 : 0;

      for (let col = 0; col < row.length; col++) {
        const x = xOffset + col * spacingX + rowStagger;
        const jitterX = Math.sin(globalIdx * 7.3) * 0.4;
        const jitterZ = Math.cos(globalIdx * 5.1) * 0.3;

        // Clamp to ground bounds
        const cx = Math.max(-GROUND_HALF, Math.min(GROUND_HALF, x + jitterX));
        const cz = Math.max(-GROUND_HALF, Math.min(GROUND_HALF, z + jitterZ));

        row[col].basePosition.set(cx, 0, cz);
        row[col].group.position.set(cx, 0, cz);

        const faceAngle = Math.PI + Math.sin(globalIdx * 3.7) * 0.3;
        row[col].group.rotation.y = faceAngle;
        row[col].baseRotationY = faceAngle;
        globalIdx++;
      }
    }
  }

  private updateLobsterStates(): void {
    const now = Date.now();
    for (const session of this.sessions) {
      const entry = this.lobsters.get(session.id);
      if (!entry) continue;

      if (session.status === 'exited') {
        entry.state = 'dead';
      } else if (session.detailedState) {
        // Map server-detected state to lobster animation state
        switch (session.detailedState) {
          case 'working':
          case 'compacting':
            entry.state = 'active';
            break;
          case 'permission_needed':
            entry.state = 'waiting';
            break;
          case 'error':
            entry.state = 'error';
            break;
          case 'idle':
            entry.state = 'idle';
            break;
          case 'starting':
          default: {
            // Fallback to timestamp-based for starting state
            const elapsed = now - new Date(session.lastActivityAt).getTime();
            if (elapsed < ACTIVITY_THRESHOLD_MS) entry.state = 'active';
            else entry.state = 'idle';
            break;
          }
        }
      } else {
        // No detailedState yet — fallback to timestamp heuristic
        const elapsed = now - new Date(session.lastActivityAt).getTime();
        if (elapsed < ACTIVITY_THRESHOLD_MS) entry.state = 'active';
        else if (elapsed < 15000) entry.state = 'waiting';
        else entry.state = 'idle';
      }
    }
  }

  // ── Animation loop ───────────────────────────────────────────────────────────

  start(): void {
    this.clock.start();
    const animate = () => {
      this.animFrameId = requestAnimationFrame(animate);
      const time = this.clock.getElapsedTime();

      this.updateLobsterStates();
      if (this.grassMaterial) this.grassMaterial.uniforms.uTime.value = time;

      for (const entry of this.lobsters.values()) {
        entry.group.position.copy(entry.basePosition);
        entry.group.rotation.set(0, entry.baseRotationY, 0);

        switch (entry.state) {
          case 'idle': animateIdle(entry.group, time); break;
          case 'active': animateActive(entry.group, time); break;
          case 'waiting': animateWaiting(entry.group, time); break;
          case 'error': animateError(entry.group, time); break;
          case 'dead': animateDead(entry.group, time); break;
        }

        animateSweatParticles(entry.sweatGroup, time, entry.state);
        this.updateLabel(entry);
      }

      // Reset whip master to base pose before animation
      this.whipMaster.position.set(-2, 0, -4);
      this.whipMaster.rotation.set(0, Math.PI * 0.1, 0);
      animateWhipMaster(this.whipMaster, time, this.lobsters.size > 0);
      this.controls.update();
      this.renderer.render(this.scene, this.camera);
    };
    animate();
  }

  stop(): void {
    cancelAnimationFrame(this.animFrameId);
    this.clock.stop();
  }

  private updateLabel(entry: LobsterEntry): void {
    const pos = entry.group.position.clone();
    pos.y += 2.5;
    pos.project(this.camera);

    if (pos.z > 1) { entry.label.style.display = 'none'; return; }

    const hw = this.container.clientWidth / 2;
    const hh = this.container.clientHeight / 2;
    entry.label.style.display = 'block';
    entry.label.style.left = `${pos.x * hw + hw}px`;
    entry.label.style.top = `${-pos.y * hh + hh}px`;

    const session = this.sessions.find((s) => s.id === entry.sessionId);
    const emojiMap: Record<LobsterState, string> = {
      idle: '\u{1F4A4}',    // 😴 sleeping
      active: '\u{1F4A6}',  // 💦 sweating
      waiting: '\u{1F440}', // 👀 looking around
      error: '\u{1F912}',   // 🤒 sick/fever
      dead: '\u{1F480}',    // 💀 skull
    };
    const emoji = emojiMap[entry.state];
    entry.label.textContent = `${emoji} ${session?.name ?? entry.sessionId}`;
    // Dead lobsters are not clickable — dim the label
    entry.label.style.opacity = entry.state === 'dead' ? '0.5' : '';
    entry.label.style.cursor = entry.state === 'dead' ? 'default' : '';
  }

  private handleResize(): void {
    const w = this.container.clientWidth;
    const h = this.container.clientHeight;
    if (w === 0 || h === 0) return;
    this.renderer.setPixelRatio(window.devicePixelRatio);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
  }

  dispose(): void {
    this.stop();
    for (const unsub of this.unsubHandlers) unsub();
    for (const entry of this.lobsters.values()) entry.label.remove();
    this.lobsters.clear();
    this.controls.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
    this.labelContainer.replaceChildren();
    this.resizeObserver.disconnect();
  }
}
