// src/game.js — Brick City Racer
import * as THREE from 'three';

// ─────────────────────────────────────────────────────────────────────────────
//  CONFIGURATION
// ─────────────────────────────────────────────────────────────────────────────
const GRID   = 5;              // city is GRID × GRID blocks
const BLOCK  = 26;             // each block footprint (world units, square)
const STREET = 10;             // street width (world units)
const CELL   = BLOCK + STREET; // 36 — one grid cell
const CITY   = GRID * CELL + STREET; // 190 — total city span
const OX     = -CITY / 2;     // world-origin offset (city centred at 0,0)
const OZ     = -CITY / 2;

// Brick dimensions
const BW  = 2.0, BH  = 0.75, BD  = 2.0; // width, height, depth
const MOR = 0.10;                          // mortar gap
const BPAD  = 2.0;                         // building inset from block edge
const BFOOT = BLOCK - BPAD * 2;           // building footprint = 22
const NBX   = Math.floor(BFOOT / (BW + MOR)); // ≈ 10 bricks across X
const NBZ   = Math.floor(BFOOT / (BD + MOR)); // ≈ 10 bricks across Z
const MIN_FL = 4, MAX_FL = 14;

// Car
const CAR_W   = 2.2, CAR_L = 4.0;
const MAX_FWD = 25, MAX_REV = 7;
const ACCEL   = 20, BRAKE_F = 32, FRIC = 3.0, TURN = 2.1;

// Physics
const GRAV       = -22;
const MIN_IMPACT = 7;    // m/s — minimum speed to shatter bricks
const BRICK_SPD  = 14;   // flying-brick launch speed

// ─────────────────────────────────────────────────────────────────────────────
//  RENDERER
// ─────────────────────────────────────────────────────────────────────────────
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.1;
document.body.appendChild(renderer.domElement);

window.addEventListener('resize', () => {
  renderer.setSize(window.innerWidth, window.innerHeight);
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
});

// ─────────────────────────────────────────────────────────────────────────────
//  SCENE
// ─────────────────────────────────────────────────────────────────────────────
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0b0d16);
scene.fog = new THREE.FogExp2(0x0b0d16, 0.003);

// ─────────────────────────────────────────────────────────────────────────────
//  CAMERA  (tilted chase cam — positioned behind and above the car)
// ─────────────────────────────────────────────────────────────────────────────
const camera = new THREE.PerspectiveCamera(
  52, window.innerWidth / window.innerHeight, 0.5, 700
);
const CAM_H    = 35;  // height above ground
const CAM_BACK = 35;  // units behind the car

// ─────────────────────────────────────────────────────────────────────────────
//  LIGHTING
// ─────────────────────────────────────────────────────────────────────────────
scene.add(new THREE.AmbientLight(0x445566, 0.9));

const sun = new THREE.DirectionalLight(0xfff0cc, 1.8);
sun.position.set(80, 150, 60);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
Object.assign(sun.shadow.camera, { left: -170, right: 170, top: 170, bottom: -170, near: 1, far: 600 });
scene.add(sun);

// Neon accent point-lights scattered around the city
[0xff0044, 0x00ffaa, 0xff7700, 0x7700ff, 0x00ccff].forEach((c, i) => {
  const pl = new THREE.PointLight(c, 3.5, 80);
  pl.position.set(Math.cos((i / 5) * Math.PI * 2) * 85, 14,
                  Math.sin((i / 5) * Math.PI * 2) * 85);
  scene.add(pl);
});

// ─────────────────────────────────────────────────────────────────────────────
//  GROUND & STREETS
// ─────────────────────────────────────────────────────────────────────────────
// Base dark ground
const gndMesh = new THREE.Mesh(
  new THREE.PlaneGeometry(CITY + 60, CITY + 60),
  new THREE.MeshLambertMaterial({ color: 0x090b12 })
);
gndMesh.rotation.x = -Math.PI / 2;
gndMesh.receiveShadow = true;
scene.add(gndMesh);

// Street surface (brighter asphalt — so track markings pop)
const stMat = new THREE.MeshLambertMaterial({ color: 0x252538 });
function addPlane(cx, cz, w, d) {
  const m = new THREE.Mesh(new THREE.PlaneGeometry(w, d), stMat);
  m.rotation.x = -Math.PI / 2;
  m.position.set(cx, 0.005, cz);
  m.receiveShadow = true;
  scene.add(m);
}
for (let i = 0; i <= GRID; i++) addPlane(0,  OZ + i * CELL + STREET / 2, CITY,   STREET);
for (let j = 0; j <= GRID; j++) addPlane(OX + j * CELL + STREET / 2, 0,  STREET, CITY);

// ─────────────────────────────────────────────────────────────────────────────
//  BUILDINGS  ─ Individual translucent coloured bricks via InstancedMesh
// ─────────────────────────────────────────────────────────────────────────────
const PALETTE = [
  0xff1155, 0xff6600, 0xffdd00, 0x00ff88, 0x00aaff,
  0xaa00ff, 0xff44bb, 0x33ffee, 0xff9922, 0x22ccff,
  0xffcc00, 0x00ff44, 0xff2299, 0x44ffaa, 0x88ff00,
];
const rndCol = () => PALETTE[Math.floor(Math.random() * PALETTE.length)];

// Describe each building
const buildings = [];
let totalBricks = 0;
for (let bi = 0; bi < GRID; bi++) {
  for (let bj = 0; bj < GRID; bj++) {
    const floors = MIN_FL + Math.floor(Math.random() * (MAX_FL - MIN_FL + 1));
    // Block starts one full street-width past the street origin
    const cx = OX + bj * CELL + STREET + BLOCK / 2;
    const cz = OZ + bi * CELL + STREET + BLOCK / 2;
    buildings.push({
      cx, cz, floors,
      minX: cx - BFOOT / 2, maxX: cx + BFOOT / 2,
      minZ: cz - BFOOT / 2, maxZ: cz + BFOOT / 2,
      startIdx: totalBricks,
      cnt: NBX * NBZ * floors,
    });
    totalBricks += NBX * NBZ * floors;
  }
}

const brickGeo = new THREE.BoxGeometry(BW - MOR, BH - MOR, BD - MOR);
// BoxGeometry has no 'color' vertex attribute.  THREE.js adds #define USE_COLOR
// when material.vertexColors=true, making the vertex shader compute
// vColor = geometryColor × instanceColor.  Without a white geometry colour that
// multiplication zeroes out the vivid instance colours.  Add an all-white
// attribute so USE_COLOR leaves the per-instance colour untouched.
{
  const n = brickGeo.attributes.position.count;
  brickGeo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(n * 3).fill(1), 3));
}
const brickMat = new THREE.MeshBasicMaterial({
  transparent: true,
  opacity: 0.88,
  vertexColors: true,
  depthWrite: true,
});
const brickIM = new THREE.InstancedMesh(brickGeo, brickMat, totalBricks);
brickIM.castShadow  = true;
brickIM.frustumCulled = false;

// Per-brick active flag (1 = static/visible, 0 = detached)
const bActive = new Uint8Array(totalBricks).fill(1);

const _mt = new THREE.Matrix4();
const _ct = new THREE.Color();

buildings.forEach(b => {
  let idx = b.startIdx;
  for (let fl = 0; fl < b.floors; fl++) {
    // Two alternating vivid colours per floor give a classic brick checkerboard
    const colA = rndCol();
    const colB = rndCol();
    for (let rz = 0; rz < NBZ; rz++) {
      for (let bx = 0; bx < NBX; bx++) {
        const wx = b.minX + bx * (BW + MOR) + BW / 2;
        const wy = fl * (BH + MOR) + BH / 2;
        const wz = b.minZ + rz * (BD + MOR) + BD / 2;
        _mt.setPosition(wx, wy, wz);
        brickIM.setMatrixAt(idx, _mt);
        // Checkerboard: alternate the two floor colours by parity
        _ct.setHex((bx + rz) % 2 === 0 ? colA : colB);
        brickIM.setColorAt(idx, _ct);
        idx++;
      }
    }
  }
});
brickIM.instanceMatrix.needsUpdate = true;
brickIM.instanceColor.needsUpdate  = true;
scene.add(brickIM);

// ─────────────────────────────────────────────────────────────────────────────
//  FLYING BRICK PHYSICS
// ─────────────────────────────────────────────────────────────────────────────
// Small pool of reusable flying-brick materials (one per palette colour)
const flyMats = PALETTE.map(hex => new THREE.MeshBasicMaterial({
  color: hex, transparent: true, opacity: 0.90,
}));
// Shared geometry with white vertex colours (same reason as brickGeo above)
const flyGeoShared = new THREE.BoxGeometry(BW - MOR, BH - MOR, BD - MOR);
{
  const n = flyGeoShared.attributes.position.count;
  flyGeoShared.setAttribute('color', new THREE.BufferAttribute(new Float32Array(n * 3).fill(1), 3));
}

/** @type {{ mesh:THREE.Mesh, vel:THREE.Vector3, rotVel:THREE.Vector3, life:number }[]} */
const flyingBricks = [];

/**
 * Detach bricks from `building` near (impactX, impactZ) and launch them.
 * @param {object}        building   – building descriptor
 * @param {number}        impactX
 * @param {number}        impactZ
 * @param {THREE.Vector3} dir        – normalised impact direction (world XZ)
 * @param {number}        force      – car speed at impact (m/s)
 */
function detachBricks(building, impactX, impactZ, dir, force) {
  const RADIUS = 7;   // world-unit radius around impact to detach
  const MAX_DETACH = 180;
  let detached = 0;
  let idx = building.startIdx;

  // Use the building's fixed centre to derive original brick positions —
  // building.minX/minZ may have been tightened by a previous recalculation.
  const baseMinX = building.cx - BFOOT / 2;
  const baseMinZ = building.cz - BFOOT / 2;

  for (let fl = 0; fl < building.floors && detached < MAX_DETACH; fl++) {
    for (let rz = 0; rz < NBZ && detached < MAX_DETACH; rz++) {
      for (let bx = 0; bx < NBX && detached < MAX_DETACH; bx++) {
        if (!bActive[idx]) { idx++; continue; }

        const wx = baseMinX + bx * (BW + MOR) + BW / 2;
        const wz = baseMinZ + rz * (BD + MOR) + BD / 2;
        const dist = Math.hypot(wx - impactX, wz - impactZ);

        if (dist < RADIUS) {
          // Hide instance by zeroing its scale
          _mt.makeScale(0, 0, 0);
          brickIM.setMatrixAt(idx, _mt);
          bActive[idx] = 0;

          // Spawn a flying mesh
          const wy = fl * (BH + MOR) + BH / 2;
          const mat = flyMats[Math.floor(Math.random() * flyMats.length)];
          const mesh = new THREE.Mesh(flyGeoShared, mat);
          mesh.position.set(wx, wy, wz);
          mesh.castShadow = true;
          scene.add(mesh);

          const spread = () => (Math.random() - 0.5) * 6;
          const upward = Math.random() * 9 + 3;
          const fwd    = force * 0.4 + Math.random() * 3;
          flyingBricks.push({
            mesh,
            vel: new THREE.Vector3(
              dir.x * fwd + spread(),
              upward,
              dir.z * fwd + spread()
            ),
            rotVel: new THREE.Vector3(
              (Math.random() - 0.5) * 8,
              (Math.random() - 0.5) * 8,
              (Math.random() - 0.5) * 8
            ),
            life: 7 + Math.random() * 3,
          });
          detached++;
        }
        idx++;
      }
    }
  }

  if (detached > 0) {
    brickIM.instanceMatrix.needsUpdate = true;
    recalcBuildingBounds(building);
  }
}

/**
 * Recompute the tight AABB for a building from its remaining active bricks.
 * Called after bricks are detached so collision edges stay accurate.
 * @param {object} building – building descriptor
 */
function recalcBuildingBounds(building) {
  const baseMinX = building.cx - BFOOT / 2;
  const baseMinZ = building.cz - BFOOT / 2;
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  let idx = building.startIdx;

  for (let fl = 0; fl < building.floors; fl++) {
    for (let rz = 0; rz < NBZ; rz++) {
      for (let bx = 0; bx < NBX; bx++) {
        if (bActive[idx]) {
          const wx = baseMinX + bx * (BW + MOR) + BW / 2;
          const wz = baseMinZ + rz * (BD + MOR) + BD / 2;
          if (wx - BW / 2 < minX) minX = wx - BW / 2;
          if (wx + BW / 2 > maxX) maxX = wx + BW / 2;
          if (wz - BD / 2 < minZ) minZ = wz - BD / 2;
          if (wz + BD / 2 > maxZ) maxZ = wz + BD / 2;
        }
        idx++;
      }
    }
  }

  if (minX <= maxX) {
    building.minX = minX;
    building.maxX = maxX;
    building.minZ = minZ;
    building.maxZ = maxZ;
  } else {
    // All bricks gone — shrink box to a point so the car passes through freely
    building.minX = building.maxX = building.cx;
    building.minZ = building.maxZ = building.cz;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  RACE TRACK  ─ dashed yellow centre-line around the outer perimeter
// ─────────────────────────────────────────────────────────────────────────────
//  Outer street centre-lines:
const TZ = OZ + STREET / 2;         // top
const BZ = OZ + CITY - STREET / 2;  // bottom
const LX = OX + STREET / 2;         // left
const RX = OX + CITY - STREET / 2;  // right

const dashMat = new THREE.MeshBasicMaterial({ color: 0xffee00 });

function drawDashes(x1, z1, x2, z2) {
  const DASH = 3, GAP = 2;
  const dx = x2 - x1, dz = z2 - z1;
  const len = Math.hypot(dx, dz);
  const angle = Math.atan2(dx, dz); // rotation around Y for a flat plane
  for (let d = 0; d < len; d += DASH + GAP) {
    const dl  = Math.min(DASH, len - d);
    const frac = (d + dl / 2) / len;
    const g = new THREE.PlaneGeometry(0.7, dl);
    g.rotateX(-Math.PI / 2);
    const m = new THREE.Mesh(g, dashMat);
    m.position.set(x1 + dx * frac, 0.015, z1 + dz * frac);
    m.rotation.y = angle;
    scene.add(m);
  }
}

// Outer perimeter circuit: top → right → bottom → left
drawDashes(LX, TZ, RX, TZ);  // top  (west → east)
drawDashes(RX, TZ, RX, BZ);  // right (north → south)
drawDashes(RX, BZ, LX, BZ);  // bottom (east → west)
drawDashes(LX, BZ, LX, TZ);  // left  (south → north)

// Inner shortcut loop (through the middle streets)
const MX = OX + Math.floor(GRID / 2) * CELL + STREET / 2;  // middle vertical street centre-x
const MZ = OZ + Math.floor(GRID / 2) * CELL + STREET / 2;  // middle horizontal street centre-z
drawDashes(LX, MZ, RX, MZ);   // middle horizontal
drawDashes(MX, TZ, MX, BZ);   // middle vertical

// Checkpoint arches
const CHECKPOINTS = [
  { x:  0,  z: TZ,  ry: 0           }, // top mid
  { x: RX,  z:  0,  ry: Math.PI / 2 }, // right mid
  { x:  0,  z: BZ,  ry: 0           }, // bottom mid
  { x: LX,  z:  0,  ry: Math.PI / 2 }, // left mid
];
const archMat = new THREE.MeshBasicMaterial({ color: 0x00ffcc, wireframe: true });
CHECKPOINTS.forEach(cp => {
  const arch = new THREE.Mesh(new THREE.TorusGeometry(4.2, 0.3, 8, 24), archMat);
  arch.position.set(cp.x, 4.2, cp.z);
  arch.rotation.y = cp.ry;
  scene.add(arch);
  // Glow poles either side of arch
  const poleMat = new THREE.MeshBasicMaterial({ color: 0x00ffcc });
  const poleGeo = new THREE.CylinderGeometry(0.12, 0.12, 8.5, 6);
  [-4.5, 4.5].forEach(off => {
    const pole = new THREE.Mesh(poleGeo, poleMat);
    const ox = cp.ry !== 0 ? 0 : off;
    const oz = cp.ry !== 0 ? off : 0;
    pole.position.set(cp.x + ox, 4.25, cp.z + oz);
    scene.add(pole);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
//  PLAYER CAR
// ─────────────────────────────────────────────────────────────────────────────
const carGroup = new THREE.Group();

// Body
carGroup.add(Object.assign(
  new THREE.Mesh(
    new THREE.BoxGeometry(CAR_W, 0.55, CAR_L),
    new THREE.MeshPhongMaterial({ color: 0xff2200, shininess: 130, emissive: 0x1a0000 })
  ),
  { castShadow: true }
));

// Cabin (dark tinted glass)
const cabin = new THREE.Mesh(
  new THREE.BoxGeometry(CAR_W * 0.78, 0.40, CAR_L * 0.52),
  new THREE.MeshPhongMaterial({ color: 0x112244, transparent: true, opacity: 0.80, shininess: 220 })
);
cabin.position.set(0, 0.475, -0.18);
carGroup.add(cabin);

// Wheels
const wGeo = new THREE.CylinderGeometry(0.38, 0.38, 0.22, 12);
const wMat = new THREE.MeshPhongMaterial({ color: 0x111111 });
[[-1.12, -0.27, 1.55], [1.12, -0.27, 1.55],
 [-1.12, -0.27, -1.55], [1.12, -0.27, -1.55]].forEach(([x, y, z]) => {
  const w = new THREE.Mesh(wGeo, wMat);
  w.rotation.z = Math.PI / 2;
  w.position.set(x, y, z);
  carGroup.add(w);
});

// Headlights
const hlMat = new THREE.MeshBasicMaterial({ color: 0xffffaa });
[[-0.7, 0, 2.05], [0.7, 0, 2.05]].forEach(([x, y, z]) => {
  const hl = new THREE.Mesh(new THREE.BoxGeometry(0.28, 0.16, 0.05), hlMat);
  hl.position.set(x, y, z);
  carGroup.add(hl);
  const pl = new THREE.PointLight(0xffffff, 1.2, 18);
  pl.position.set(x, y + 0.5, z + 1);
  carGroup.add(pl);
});

// Tail-lights
const tlMat = new THREE.MeshBasicMaterial({ color: 0xff2200 });
[[-0.7, 0, -2.05], [0.7, 0, -2.05]].forEach(([x, y, z]) => {
  const tl = new THREE.Mesh(new THREE.BoxGeometry(0.24, 0.14, 0.05), tlMat);
  tl.position.set(x, y, z);
  carGroup.add(tl);
});

carGroup.castShadow = true;
scene.add(carGroup);

// Car state — start on the top street heading east
const carPos   = new THREE.Vector3(LX + 3, 0.5, TZ);
let   carAngle = Math.PI / 2;   // facing +X (east)
let   carSpeed = 0;

// ─────────────────────────────────────────────────────────────────────────────
//  INPUT
// ─────────────────────────────────────────────────────────────────────────────
const keys = {};
window.addEventListener('keydown', e => { keys[e.code] = true;  e.preventDefault(); });
window.addEventListener('keyup',   e => { keys[e.code] = false; });
const held = (...codes) => codes.some(c => keys[c]);

// ─────────────────────────────────────────────────────────────────────────────
//  RACE STATE
// ─────────────────────────────────────────────────────────────────────────────
const TOTAL_LAPS = 3;
let lap      = 1;
let nextCP   = 0;
let startTs  = null;     // performance.now() at lap start
let bestLap  = Infinity;
let finished = false;

function checkCheckpoints() {
  if (finished) return;
  if (startTs === null) startTs = performance.now();
  const cp = CHECKPOINTS[nextCP];
  if (Math.hypot(carPos.x - cp.x, carPos.z - cp.z) < 9) {
    nextCP = (nextCP + 1) % CHECKPOINTS.length;
    if (nextCP === 0) {
      // Completed a lap
      const t = (performance.now() - startTs) / 1000;
      if (t < bestLap) bestLap = t;
      startTs = performance.now();
      if (lap < TOTAL_LAPS) {
        lap++;
        showFlash(`LAP ${lap}`);
      } else {
        finished = true;
        showFlash('FINISH!');
      }
    }
  }
}

function showFlash(text) {
  const el = document.getElementById('lapflash');
  el.textContent = text;
  el.style.opacity = '1';
  setTimeout(() => { el.style.opacity = '0'; }, 1800);
}

// ─────────────────────────────────────────────────────────────────────────────
//  HUD
// ─────────────────────────────────────────────────────────────────────────────
const elSpeed = document.getElementById('speed');
const elLap   = document.getElementById('lap');
const elTime  = document.getElementById('time');
const elBest  = document.getElementById('bestlap');

function fmtTime(s) {
  const m  = Math.floor(s / 60);
  const ss = (s % 60).toFixed(3).padStart(6, '0');
  return `${m}:${ss}`;
}

// ─────────────────────────────────────────────────────────────────────────────
//  MINIMAP
// ─────────────────────────────────────────────────────────────────────────────
const mmEl  = /** @type {HTMLCanvasElement} */ (document.getElementById('minimap'));
const mmCtx = mmEl.getContext('2d');
mmEl.width  = 170;
mmEl.height = 170;
const MM  = 170;
const toMM = (x, z) => [(x - OX) / CITY * MM, (z - OZ) / CITY * MM];

function drawMinimap() {
  mmCtx.clearRect(0, 0, MM, MM);

  // Buildings
  mmCtx.fillStyle = '#223';
  buildings.forEach(b => {
    const [mx, mz] = toMM(b.minX, b.minZ);
    mmCtx.fillRect(mx, mz, BFOOT / CITY * MM, BFOOT / CITY * MM);
  });

  // Track (outer loop)
  mmCtx.strokeStyle = '#ffee00';
  mmCtx.lineWidth = 1.5;
  mmCtx.beginPath();
  [[LX, TZ],[RX, TZ],[RX, BZ],[LX, BZ],[LX, TZ]].forEach(([x, z], i) => {
    const [mx, mz] = toMM(x, z);
    i === 0 ? mmCtx.moveTo(mx, mz) : mmCtx.lineTo(mx, mz);
  });
  mmCtx.stroke();

  // Checkpoints
  mmCtx.fillStyle = '#00ffcc';
  CHECKPOINTS.forEach((cp, i) => {
    const [mx, mz] = toMM(cp.x, cp.z);
    mmCtx.beginPath();
    mmCtx.arc(mx, mz, i === nextCP ? 4 : 2.5, 0, Math.PI * 2);
    mmCtx.fill();
  });

  // Car (arrow)
  const [cx, cz] = toMM(carPos.x, carPos.z);
  mmCtx.save();
  mmCtx.translate(cx, cz);
  mmCtx.rotate(carAngle);
  mmCtx.fillStyle = '#ff4400';
  mmCtx.beginPath();
  mmCtx.moveTo(0, -5);
  mmCtx.lineTo(3, 4);
  mmCtx.lineTo(-3, 4);
  mmCtx.closePath();
  mmCtx.fill();
  mmCtx.restore();
}

// ─────────────────────────────────────────────────────────────────────────────
//  MAIN LOOP
// ─────────────────────────────────────────────────────────────────────────────
const clock = new THREE.Clock();

function animate() {
  requestAnimationFrame(animate);
  const dt = Math.min(clock.getDelta(), 0.05);

  // ── Car physics ─────────────────────────────────────────────────────────────
  const turning = (held('ArrowLeft','KeyA') ? 1 : 0) - (held('ArrowRight','KeyD') ? 1 : 0);
  if (Math.abs(carSpeed) > 0.4) {
    carAngle += turning * TURN * Math.sign(carSpeed) * dt;
  }

  if (held('ArrowUp', 'KeyW')) {
    carSpeed += ACCEL * dt;
  } else if (held('ArrowDown', 'KeyS') || held('Space')) {
    carSpeed > 0 ? (carSpeed -= BRAKE_F * dt) : (carSpeed -= ACCEL * 0.5 * dt);
  } else {
    const drag = FRIC * dt;
    carSpeed = Math.abs(carSpeed) < drag ? 0 : carSpeed - Math.sign(carSpeed) * drag;
  }
  carSpeed = Math.max(-MAX_REV, Math.min(MAX_FWD, carSpeed));

  const prevX = carPos.x, prevZ = carPos.z;
  carPos.x += Math.sin(carAngle) * carSpeed * dt;
  carPos.z += Math.cos(carAngle) * carSpeed * dt;

  // City boundary clamp
  const bound = CITY / 2 + 8;
  carPos.x = Math.max(-bound, Math.min(bound, carPos.x));
  carPos.z = Math.max(-bound, Math.min(bound, carPos.z));

  // ── Building collision ───────────────────────────────────────────────────────
  const hw = CAR_W / 2 + 0.15;
  const hl = CAR_L / 2 + 0.15;
  for (const b of buildings) {
    if (carPos.x - hw < b.maxX && carPos.x + hw > b.minX &&
        carPos.z - hl < b.maxZ && carPos.z + hl > b.minZ) {

      if (Math.abs(carSpeed) >= MIN_IMPACT) {
        const dir = new THREE.Vector3(Math.sin(carAngle), 0, Math.cos(carAngle));
        detachBricks(b, carPos.x, carPos.z, dir, Math.abs(carSpeed));
      }

      carPos.x = prevX;
      carPos.z = prevZ;
      carSpeed *= -0.2;
      break;
    }
  }

  // ── Update car mesh ──────────────────────────────────────────────────────────
  carGroup.position.set(carPos.x, carPos.y, carPos.z);
  carGroup.rotation.y = carAngle;

  // ── Flying brick physics ─────────────────────────────────────────────────────
  let i = flyingBricks.length;
  while (i--) {
    const fb = flyingBricks[i];
    fb.vel.y += GRAV * dt;
    fb.mesh.position.addScaledVector(fb.vel, dt);
    fb.mesh.rotation.x += fb.rotVel.x * dt;
    fb.mesh.rotation.y += fb.rotVel.y * dt;
    fb.mesh.rotation.z += fb.rotVel.z * dt;

    if (fb.mesh.position.y < 0.3) {
      fb.mesh.position.y = 0.3;
      fb.vel.y  = Math.abs(fb.vel.y) * 0.35;
      fb.vel.x *= 0.72;
      fb.vel.z *= 0.72;
      fb.rotVel.multiplyScalar(0.6);
    }

    fb.life -= dt;
    if (fb.life <= 0) {
      scene.remove(fb.mesh);
      flyingBricks.splice(i, 1);
    }
  }

  // ── Camera (tilted chase cam — behind and above the car) ─────────────────────
  // Camera is positioned CAM_BACK units behind the car and CAM_H units up,
  // looking at the car's ground position.  camera.up uses world-Y so the view
  // stays right-side up regardless of the car's heading.
  camera.position.set(
    carPos.x - Math.sin(carAngle) * CAM_BACK,
    CAM_H,
    carPos.z - Math.cos(carAngle) * CAM_BACK
  );
  camera.up.set(0, 1, 0);
  camera.lookAt(carPos.x, 0, carPos.z);

  // ── Race logic ───────────────────────────────────────────────────────────────
  checkCheckpoints();

  // ── HUD ─────────────────────────────────────────────────────────────────────
  elSpeed.textContent = Math.round(Math.abs(carSpeed) * 3.6); // m/s → km/h
  elLap.textContent   = `${lap} / ${TOTAL_LAPS}`;
  if (startTs !== null) {
    elTime.textContent = fmtTime((performance.now() - startTs) / 1000);
  }
  if (bestLap < Infinity) {
    elBest.textContent = `BEST  ${fmtTime(bestLap)}`;
  }

  // ── Minimap ──────────────────────────────────────────────────────────────────
  drawMinimap();

  renderer.render(scene, camera);
}

animate();
