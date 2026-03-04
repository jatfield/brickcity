// src/game.js — Brick City Brawl
import * as THREE from 'three';
import { io } from 'socket.io-client';

// ─────────────────────────────────────────────────────────────────────────────
//  CONFIGURATION
// ─────────────────────────────────────────────────────────────────────────────
const GRID   = 5;
const BLOCK  = 26;
const STREET = 10;
const CELL   = BLOCK + STREET;          // 36
const CITY   = GRID * CELL + STREET;    // 190
const OX     = -CITY / 2;
const OZ     = -CITY / 2;

// Brick dimensions
const BW = 2.0, BH = 0.75, BD = 2.0;
const MOR = 0.10;
const BPAD = 2.0;

// Building type templates (variety)
const BTYPE = [
  { nbxF: 1.0,  nbzF: 1.0,  minFl: 4,  maxFl: 10 }, // standard block
  { nbxF: 0.55, nbzF: 0.55, minFl: 12, maxFl: 22 }, // thin tower
  { nbxF: 1.0,  nbzF: 1.0,  minFl: 2,  maxFl: 4  }, // low-rise
  { nbxF: 0.65, nbzF: 1.0,  minFl: 7,  maxFl: 14 }, // narrow slab (Z-wide)
  { nbxF: 1.0,  nbzF: 0.55, minFl: 7,  maxFl: 14 }, // narrow slab (X-wide)
  { nbxF: 0.45, nbzF: 0.45, minFl: 16, maxFl: 28 }, // skyscraper
];
const BFOOT_MAX = BLOCK - BPAD * 2;     // 22 — max building footprint side
const MAX_NBX   = Math.floor(BFOOT_MAX / (BW + MOR)); // 10
const MAX_NBZ   = Math.floor(BFOOT_MAX / (BD + MOR)); // 10

// Buggy dimensions (for physics/collision)
const CAR_W   = 3.0, CAR_L = 3.6, CAR_H = 0.5;
const MAX_FWD = 25,  MAX_REV = 8;
const ACCEL   = 20,  BRAKE_F = 32, FRIC = 3.0, TURN = 2.2;
const COL_PAD = 0.2;

// Physics
const GRAV       = -22;
const MIN_IMPACT = 7;    // m/s to shatter bricks

// Combat
const PLAYER_HP     = 100;
const MIN_DMG_SPEED = 5;      // m/s relative speed to start dealing damage
const COLL_DIST     = 3.8;    // buggy collision distance (world units)
const RESPAWN_SECS  = 3;      // respawn delay in seconds
const DAMAGE_COOLDOWN = 0.3;  // seconds between successive damage events

// Power-ups
const POWERUP_DURATION    = 8;
const POWERUP_DROP_CHANCE = 0.45;
const POWERUP_RADIUS      = 1.8;
const POWERUP_TYPES  = ['double_speed', 'double_damage', 'shrink', 'unstoppable'];
const POWERUP_COLS   = { double_speed: 0xffdd00, double_damage: 0xff4400, shrink: 0x00aaff, unstoppable: 0x00ff44 };
const POWERUP_LABELS = { double_speed: 'DOUBLE SPEED', double_damage: 'DOUBLE DAMAGE', shrink: 'SHRINK', unstoppable: 'UNSTOPPABLE' };

// Spawn points (street corners, safe positions)
const P1_SPAWN_POS   = new THREE.Vector3(OX + STREET * 0.5 + 2,  0.5, OZ + STREET * 0.5 + 2);
const P2_SPAWN_POS   = new THREE.Vector3(OX + CITY - STREET * 0.5 - 2, 0.5, OZ + CITY - STREET * 0.5 - 2);
const P1_SPAWN_ANGLE = Math.PI * 0.25;
const P2_SPAWN_ANGLE = Math.PI * 1.25;

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
//  CAMERA
// ─────────────────────────────────────────────────────────────────────────────
const camera = new THREE.PerspectiveCamera(
  52, window.innerWidth / window.innerHeight, 0.5, 700
);
const CAM_H = 35, CAM_BACK = 35;

// ─────────────────────────────────────────────────────────────────────────────
//  LIGHTING
// ─────────────────────────────────────────────────────────────────────────────
scene.add(new THREE.AmbientLight(0x445566, 0.9));

const sun = new THREE.DirectionalLight(0xfff0cc, 1.8);
sun.position.set(80, 150, 60);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
Object.assign(sun.shadow.camera, { left: -200, right: 200, top: 200, bottom: -200, near: 1, far: 600 });
scene.add(sun);

[0xff0044, 0x00ffaa, 0xff7700, 0x7700ff, 0x00ccff].forEach((c, i) => {
  const pl = new THREE.PointLight(c, 3.5, 80);
  pl.position.set(Math.cos((i / 5) * Math.PI * 2) * 85, 14,
                  Math.sin((i / 5) * Math.PI * 2) * 85);
  scene.add(pl);
});

// ─────────────────────────────────────────────────────────────────────────────
//  GROUND & STREETS  (road + pavement + curbs)
// ─────────────────────────────────────────────────────────────────────────────
const gndMesh = new THREE.Mesh(
  new THREE.PlaneGeometry(CITY + 60, CITY + 60),
  new THREE.MeshLambertMaterial({ color: 0x090b12 })
);
gndMesh.rotation.x = -Math.PI / 2;
gndMesh.receiveShadow = true;
scene.add(gndMesh);

const roadMat    = new THREE.MeshLambertMaterial({ color: 0x1e2032 }); // dark asphalt
const paveMat    = new THREE.MeshLambertMaterial({ color: 0x7a7a82 }); // concrete pavement
const curbBoxMat = new THREE.MeshLambertMaterial({ color: 0x505060 }); // curb stone

function addFlatRect(cx, cz, w, d, mat, y) {
  const m = new THREE.Mesh(new THREE.PlaneGeometry(w, d), mat);
  m.rotation.x = -Math.PI / 2;
  m.position.set(cx, y, cz);
  m.receiveShadow = true;
  scene.add(m);
}

// Road surface (full-width crossing strips)
for (let i = 0; i <= GRID; i++)
  addFlatRect(0, OZ + i * CELL + STREET / 2, CITY, STREET, roadMat, 0.005);
for (let j = 0; j <= GRID; j++)
  addFlatRect(OX + j * CELL + STREET / 2, 0, STREET, CITY, roadMat, 0.005);

// Pavement strips (in the BPAD zone flanking each street)
for (let i = 0; i <= GRID; i++) {
  const sz = OZ + i * CELL;
  if (i < GRID)  addFlatRect(0, sz + STREET + BPAD / 2, CITY, BPAD, paveMat, 0.025);
  if (i > 0)     addFlatRect(0, sz - BPAD / 2,          CITY, BPAD, paveMat, 0.025);
}
for (let j = 0; j <= GRID; j++) {
  const sx = OX + j * CELL;
  if (j < GRID)  addFlatRect(sx + STREET + BPAD / 2, 0, BPAD, CITY, paveMat, 0.025);
  if (j > 0)     addFlatRect(sx - BPAD / 2,          0, BPAD, CITY, paveMat, 0.025);
}

// Curbs  (raised thin boxes at road/pavement boundaries)
function addCurb(cx, cz, w, d) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, 0.12, d), curbBoxMat);
  m.position.set(cx, 0.06, cz);
  scene.add(m);
}
for (let i = 0; i <= GRID; i++) {
  const sz = OZ + i * CELL;
  if (i < GRID) addCurb(0, sz + STREET + 0.15, CITY, 0.30);
  if (i > 0)    addCurb(0, sz        - 0.15,   CITY, 0.30);
}
for (let j = 0; j <= GRID; j++) {
  const sx = OX + j * CELL;
  if (j < GRID) addCurb(sx + STREET + 0.15, 0, 0.30, CITY);
  if (j > 0)    addCurb(sx          - 0.15, 0, 0.30, CITY);
}

// Road centre-line dashes (white, for each street)
const dashMat = new THREE.MeshBasicMaterial({ color: 0xffffff });
function drawCentreLines(x1, z1, x2, z2) {
  const DASH = 2.5, GAP = 2.5;
  const dx = x2 - x1, dz = z2 - z1;
  const len = Math.hypot(dx, dz);
  const ang = Math.atan2(dx, dz);
  for (let d = 0; d < len; d += DASH + GAP) {
    const dl = Math.min(DASH, len - d);
    const frac = (d + dl / 2) / len;
    const g = new THREE.PlaneGeometry(0.35, dl);
    g.rotateX(-Math.PI / 2);
    const m = new THREE.Mesh(g, dashMat);
    m.position.set(x1 + dx * frac, 0.015, z1 + dz * frac);
    m.rotation.y = ang;
    scene.add(m);
  }
}
for (let i = 0; i <= GRID; i++) {
  const cz = OZ + i * CELL + STREET / 2;
  drawCentreLines(OX, cz, OX + CITY, cz);
}
for (let j = 0; j <= GRID; j++) {
  const cx = OX + j * CELL + STREET / 2;
  drawCentreLines(cx, OZ, cx, OZ + CITY);
}

// ─────────────────────────────────────────────────────────────────────────────
//  BUILDINGS  — varied types, all translucent-brick InstancedMesh
// ─────────────────────────────────────────────────────────────────────────────
const PALETTE = [
  0xff1155, 0xff6600, 0xffdd00, 0x00ff88, 0x00aaff,
  0xaa00ff, 0xff44bb, 0x33ffee, 0xff9922, 0x22ccff,
  0xffcc00, 0x00ff44, 0xff2299, 0x44ffaa, 0x88ff00,
];
const rndCol = () => PALETTE[Math.floor(Math.random() * PALETTE.length)];

// Seeded RNG — both clients must generate identical building structures so
// that global brick indices correspond to the same bricks on each machine.
let _rngState = 0x29a;
function cityRand() {
  _rngState ^= _rngState << 13;
  _rngState ^= _rngState >> 17;
  _rngState ^= _rngState << 5;
  return ((_rngState >>> 0) / 4294967296);
}

const buildings = [];
let totalBricks = 0;
let destroyedBrickCount = 0;  // total bricks destroyed (local + remote)
let myDestroyedBricks    = 0; // bricks destroyed by local player
let enemyDestroyedBricks = 0; // bricks destroyed by remote player

for (let bi = 0; bi < GRID; bi++) {
  for (let bj = 0; bj < GRID; bj++) {
    const t = BTYPE[Math.floor(cityRand() * BTYPE.length)];
    const nbx = Math.max(3, Math.floor(MAX_NBX * t.nbxF));
    const nbz = Math.max(3, Math.floor(MAX_NBZ * t.nbzF));
    const floors = t.minFl + Math.floor(cityRand() * (t.maxFl - t.minFl + 1));
    const footX = nbx * (BW + MOR);
    const footZ = nbz * (BD + MOR);
    // centre the building within the block
    const bx0 = OX + bj * CELL + STREET + (BLOCK - footX) / 2;
    const bz0 = OZ + bi * CELL + STREET + (BLOCK - footZ) / 2;
    buildings.push({
      cx: bx0 + footX / 2,
      cz: bz0 + footZ / 2,
      bx0, bz0,
      nbx, nbz, floors,
      minX: bx0,          maxX: bx0 + footX,
      minZ: bz0,          maxZ: bz0 + footZ,
      startIdx: totalBricks,
      cnt: nbx * nbz * floors,
    });
    totalBricks += nbx * nbz * floors;
  }
}

const brickGeo = new THREE.BoxGeometry(BW - MOR, BH - MOR, BD - MOR);
{
  const n = brickGeo.attributes.position.count;
  brickGeo.setAttribute('color',
    new THREE.BufferAttribute(new Float32Array(n * 3).fill(1), 3));
}
const brickMat = new THREE.MeshBasicMaterial({
  transparent: true, opacity: 0.88, vertexColors: true, depthWrite: true,
});
const brickIM = new THREE.InstancedMesh(brickGeo, brickMat, totalBricks);
brickIM.castShadow = true;
brickIM.frustumCulled = false;

const bActive = new Uint8Array(totalBricks).fill(1);
const _mt = new THREE.Matrix4();
const _ct = new THREE.Color();

buildings.forEach(b => {
  let idx = b.startIdx;
  for (let fl = 0; fl < b.floors; fl++) {
    const colA = rndCol();
    const colB = rndCol();
    for (let rz = 0; rz < b.nbz; rz++) {
      for (let bx = 0; bx < b.nbx; bx++) {
        const wx = b.bx0 + bx * (BW + MOR) + BW / 2;
        const wy = fl * (BH + MOR) + BH / 2;
        const wz = b.bz0 + rz * (BD + MOR) + BD / 2;
        _mt.setPosition(wx, wy, wz);
        brickIM.setMatrixAt(idx, _mt);
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
//  LAMPPOSTS  (entirely cube geometry — post + arm + head)
// ─────────────────────────────────────────────────────────────────────────────
const postMat  = new THREE.MeshPhongMaterial({ color: 0x8899aa, shininess: 80 });
const lampMat  = new THREE.MeshBasicMaterial({ color: 0xffffcc });

function addLamppost(x, z, armDX, armDZ, addLight = true) {
  const ARM = 1.8, POST_H = 5.2;
  // Base cube
  const base = new THREE.Mesh(new THREE.BoxGeometry(0.75, 0.45, 0.75), postMat);
  base.position.set(x, 0.225, z);
  scene.add(base);
  // Post (tall thin cube)
  const post = new THREE.Mesh(new THREE.BoxGeometry(0.22, POST_H, 0.22), postMat);
  post.position.set(x, POST_H / 2, z);
  scene.add(post);
  // Arm (horizontal cube pointing toward road)
  const arm = new THREE.Mesh(new THREE.BoxGeometry(
    Math.abs(armDX) > 0 ? ARM : 0.18,
    0.18,
    Math.abs(armDZ) > 0 ? ARM : 0.18
  ), postMat);
  arm.position.set(x + armDX * ARM / 2, POST_H + 0.09, z + armDZ * ARM / 2);
  scene.add(arm);
  // Light head cube
  const head = new THREE.Mesh(new THREE.BoxGeometry(0.60, 0.28, 0.60), lampMat);
  head.position.set(x + armDX * ARM, POST_H - 0.28, z + armDZ * ARM);
  scene.add(head);
  // Actual point light (intersection corners only — mid-block lamps are decorative)
  if (addLight) {
    const pl = new THREE.PointLight(0xffffcc, 2.2, 20);
    pl.position.set(x + armDX * ARM, POST_H - 0.6, z + armDZ * ARM);
    scene.add(pl);
  }
}

// Place one lamppost per intersection corner (SW corner of the NE block)
for (let i = 0; i <= GRID; i++) {
  for (let j = 0; j <= GRID; j++) {
    // SW corner of block (i, j) = just past the NE intersection corner
    if (i < GRID && j < GRID) {
      const lx = OX + j * CELL + STREET + BPAD * 0.5;
      const lz = OZ + i * CELL + STREET + BPAD * 0.5;
      // arm points SW (toward the intersection)
      addLamppost(lx, lz, -0.707, -0.707);
    }
  }
}
// Extra lamps along long block edges (mid-block, both sides of each street)
for (let i = 0; i <= GRID; i++) {
  const sz = OZ + i * CELL;
  for (let j = 0; j < GRID; j++) {
    const mx = OX + j * CELL + STREET + BLOCK / 2; // mid-block X
    if (i < GRID) {
      // north sidewalk of street i → arm points south (-Z)
      addLamppost(mx, sz + STREET + BPAD * 0.5, 0, -1, false);
    }
    if (i > 0) {
      // south sidewalk of street i → arm points north (+Z)
      addLamppost(mx, sz - BPAD * 0.5, 0, 1, false);
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  FLYING BRICK PHYSICS
// ─────────────────────────────────────────────────────────────────────────────
const flyMats = PALETTE.map(hex =>
  new THREE.MeshBasicMaterial({ color: hex, transparent: true, opacity: 0.90 })
);
const flyGeo = new THREE.BoxGeometry(BW - MOR, BH - MOR, BD - MOR);
{
  const n = flyGeo.attributes.position.count;
  flyGeo.setAttribute('color',
    new THREE.BufferAttribute(new Float32Array(n * 3).fill(1), 3));
}
/** @type {{ mesh:THREE.Mesh, vel:THREE.Vector3, rotVel:THREE.Vector3, life:number }[]} */
const flyingBricks = [];
// Cap the number of simultaneous flying-brick meshes to keep GPU draw calls
// and array overhead bounded; bricks beyond the limit are still removed from
// the instanced mesh (so no floating geometry) but won't spawn a flying mesh.
const MAX_FLYING_BRICKS = 400;

function detachBricks(building, impactX, impactZ, dir, force, activePowerup) {
  let RADIUS = activePowerup === 'double_damage' ? 14 : 7;
  if (activePowerup === 'shrink') RADIUS = 3;   // smaller radius while shrunk
  // Limit columns, not individual bricks, so entire columns are always fully
  // removed. 25 columns ≈ the original 180-brick limit for an average 7-floor
  // building, while preventing upper floors from being orphaned.
  const MAX_COLS = 25;  // max XZ columns to detach per impact
  let colsDetached = 0;
  const destroyed = [];

  // Iterate columns (XZ) first so entire columns are removed together,
  // preventing upper floors from floating when lower floors are destroyed.
  for (let rz = 0; rz < building.nbz && colsDetached < MAX_COLS; rz++) {
    for (let bx = 0; bx < building.nbx && colsDetached < MAX_COLS; bx++) {
      const wx = building.bx0 + bx * (BW + MOR) + BW / 2;
      const wz = building.bz0 + rz * (BD + MOR) + BD / 2;
      if (Math.hypot(wx - impactX, wz - impactZ) >= RADIUS) continue;
      colsDetached++;
      for (let fl = 0; fl < building.floors; fl++) {
        const idx = building.startIdx + fl * building.nbz * building.nbx + rz * building.nbx + bx;
        if (!bActive[idx]) continue;
        bActive[idx] = 0;
        destroyed.push(idx);
        _mt.makeScale(0, 0, 0);
        brickIM.setMatrixAt(idx, _mt);

        if (flyingBricks.length < MAX_FLYING_BRICKS) {
          const wy = fl * (BH + MOR) + BH / 2;
          const mat = flyMats[Math.floor(Math.random() * flyMats.length)];
          const mesh = new THREE.Mesh(flyGeo, mat);
          mesh.position.set(wx, wy, wz);
          mesh.castShadow = true;
          scene.add(mesh);

          const spread = () => (Math.random() - 0.5) * 6;
          flyingBricks.push({
            mesh,
            vel: new THREE.Vector3(
              dir.x * (force * 0.4 + Math.random() * 3) + spread(),
              Math.random() * 9 + 3,
              dir.z * (force * 0.4 + Math.random() * 3) + spread()
            ),
            rotVel: new THREE.Vector3(
              (Math.random() - 0.5) * 8,
              (Math.random() - 0.5) * 8,
              (Math.random() - 0.5) * 8
            ),
            life: 7 + Math.random() * 3,
          });
        }
      }
    }
  }

  if (destroyed.length > 0) {
    brickIM.instanceMatrix.needsUpdate = true;
    recalcBuildingBounds(building);
    if (Math.random() < POWERUP_DROP_CHANCE) spawnPowerup(impactX, impactZ);
  }
  return destroyed;
}

function recalcBuildingBounds(b) {
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  let idx = b.startIdx;
  for (let fl = 0; fl < b.floors; fl++) {
    for (let rz = 0; rz < b.nbz; rz++) {
      for (let bx = 0; bx < b.nbx; bx++) {
        if (bActive[idx]) {
          const wx = b.bx0 + bx * (BW + MOR) + BW / 2;
          const wz = b.bz0 + rz * (BD + MOR) + BD / 2;
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
    b.minX = minX; b.maxX = maxX;
    b.minZ = minZ; b.maxZ = maxZ;
  } else {
    b.minX = b.maxX = b.cx;
    b.minZ = b.maxZ = b.cz;
  }
}

function hasActiveBrickInBox(b, minX, maxX, minZ, maxZ, minY, maxY) {
  for (let fl = 0; fl < b.floors; fl++) {
    const flMinY = fl * (BH + MOR), flMaxY = flMinY + BH;
    if (flMaxY <= minY || flMinY >= maxY) continue;
    for (let rz = 0; rz < b.nbz; rz++) {
      const wz = b.bz0 + rz * (BD + MOR) + BD / 2;
      if (wz + BD / 2 <= minZ || wz - BD / 2 >= maxZ) continue;
      for (let bx = 0; bx < b.nbx; bx++) {
        const wx = b.bx0 + bx * (BW + MOR) + BW / 2;
        if (wx + BW / 2 <= minX || wx - BW / 2 >= maxX) continue;
        const idx = b.startIdx + fl * b.nbz * b.nbx + rz * b.nbx + bx;
        if (bActive[idx]) return true;
      }
    }
  }
  return false;
}

// Push car out of any overlapping buildings (used after shrink expires)
const OVERLAP_PUSH_STEP  = 0.5;  // world units per resolution step
const MAX_OVERLAP_STEPS  = 60;   // max steps before giving up (30 units max travel)

function resolveBuildingOverlap() {
  const saA = Math.abs(Math.sin(carAngle)), caA = Math.abs(Math.cos(carAngle));
  const hw = saA * CAR_L / 2 + caA * CAR_W / 2 + COL_PAD;
  const hl = caA * CAR_L / 2 + saA * CAR_W / 2 + COL_PAD;
  const carMinY = carPos.y - CAR_H / 2;
  const carMaxY = carPos.y + CAR_H / 2;
  for (const b of buildings) {
    if (!hasActiveBrickInBox(b, carPos.x - hw, carPos.x + hw,
        carPos.z - hl, carPos.z + hl, carMinY, carMaxY)) continue;
    let pushX = carPos.x - b.cx;
    let pushZ = carPos.z - b.cz;
    const len = Math.hypot(pushX, pushZ);
    if (len < OVERLAP_PUSH_STEP) { pushX = 1; pushZ = 0; } else { pushX /= len; pushZ /= len; }
    for (let step = 0; step < MAX_OVERLAP_STEPS; step++) {
      carPos.x += pushX * OVERLAP_PUSH_STEP;
      carPos.z += pushZ * OVERLAP_PUSH_STEP;
      if (!hasActiveBrickInBox(b, carPos.x - hw, carPos.x + hw,
          carPos.z - hl, carPos.z + hl, carMinY, carMaxY)) break;
    }
    carSpeed = 0;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  POWER-UPS
// ─────────────────────────────────────────────────────────────────────────────
/** @type {{ mesh: THREE.Mesh, type: string, vy: number, landed: boolean, bobT: number }[]} */
const powerupItems = [];

function spawnPowerup(ix, iz) {
  const type = POWERUP_TYPES[Math.floor(Math.random() * POWERUP_TYPES.length)];
  const pMesh = new THREE.Mesh(
    new THREE.BoxGeometry(1.4, 1.4, 1.4),
    new THREE.MeshBasicMaterial({ color: POWERUP_COLS[type] })
  );
  pMesh.position.set(ix + (Math.random() - 0.5) * 4, 8, iz + (Math.random() - 0.5) * 4);
  scene.add(pMesh);
  powerupItems.push({ mesh: pMesh, type, vy: 0, landed: false, bobT: 0 });
}

// ─────────────────────────────────────────────────────────────────────────────
//  SHINY BUGGY  model factory
// ─────────────────────────────────────────────────────────────────────────────
function createBuggy(bodyHex) {
  const g = new THREE.Group();
  const bodyMat  = new THREE.MeshPhongMaterial({
    color: bodyHex, shininess: 280,
    specular: new THREE.Color(0.9, 0.9, 0.9),
    emissive: new THREE.Color(bodyHex).multiplyScalar(0.06),
  });
  const metalMat = new THREE.MeshPhongMaterial({ color: 0x999aaa, shininess: 200, specular: 0xffffff });
  const darkMat  = new THREE.MeshPhongMaterial({ color: 0x111122, shininess: 50 });
  const glowMat  = new THREE.MeshBasicMaterial({ color: 0xffffaa });
  const tailMat  = new THREE.MeshBasicMaterial({ color: 0xff2200 });

  // ── chassis body (flat, wide)
  const body = new THREE.Mesh(new THREE.BoxGeometry(3.0, 0.46, 3.6), bodyMat);
  body.castShadow = true;
  g.add(body);

  // ── skid plate (metal underside)
  const skid = new THREE.Mesh(new THREE.BoxGeometry(2.7, 0.14, 3.4), metalMat);
  skid.position.y = -0.30;
  g.add(skid);

  // ── seat pan
  const seatPan = new THREE.Mesh(new THREE.BoxGeometry(2.2, 0.14, 1.8),
    new THREE.MeshPhongMaterial({ color: 0x1a1a2e, shininess: 20 }));
  seatPan.position.set(0, 0.30, 0.05);
  g.add(seatPan);

  // ── rollcage vertical posts (4 corners)
  const postGeo = new THREE.BoxGeometry(0.13, 1.70, 0.13);
  [[-1.1, 0.85, 1.35], [1.1, 0.85, 1.35],
   [-1.1, 0.85, -0.85], [1.1, 0.85, -0.85]].forEach(([px, py, pz]) => {
    const p = new THREE.Mesh(postGeo, metalMat);
    p.position.set(px, py, pz);
    g.add(p);
  });
  // rollcage top X-bars
  [1.35, -0.85].forEach(pz => {
    const xb = new THREE.Mesh(new THREE.BoxGeometry(2.25, 0.13, 0.13), metalMat);
    xb.position.set(0, 1.72, pz);
    g.add(xb);
  });
  // rollcage longitudinal bars
  [-1.1, 1.1].forEach(px => {
    const lb = new THREE.Mesh(new THREE.BoxGeometry(0.13, 0.13, 2.35), metalMat);
    lb.position.set(px, 1.72, 0.25);
    g.add(lb);
  });

  // ── front bumper bar
  const bumper = new THREE.Mesh(new THREE.BoxGeometry(3.4, 0.30, 0.22), metalMat);
  bumper.position.set(0, -0.08, 1.92);
  g.add(bumper);
  // push bars (two vertical stubs on bumper)
  [-0.9, 0.9].forEach(px => {
    const pb = new THREE.Mesh(new THREE.BoxGeometry(0.13, 0.50, 0.35), metalMat);
    pb.position.set(px, 0.0, 1.95);
    g.add(pb);
  });

  // ── big wheels + hubs
  const wheelGeo = new THREE.CylinderGeometry(0.60, 0.60, 0.42, 14);
  const hubGeo   = new THREE.CylinderGeometry(0.24, 0.24, 0.43, 8);
  [[-1.60, -0.04, 1.50], [1.60, -0.04, 1.50],
   [-1.60, -0.04, -1.50], [1.60, -0.04, -1.50]].forEach(([wx, wy, wz]) => {
    const tire = new THREE.Mesh(wheelGeo, darkMat);
    tire.rotation.z = Math.PI / 2;
    tire.position.set(wx, wy, wz);
    tire.castShadow = true;
    g.add(tire);
    const hub = new THREE.Mesh(hubGeo, metalMat);
    hub.rotation.z = Math.PI / 2;
    hub.position.set(wx, wy, wz);
    g.add(hub);
  });

  // ── wheel arches (body-colored panels over wheel wells)
  [-1.35, 1.35].forEach(px => {
    [1.50, -1.50].forEach(pz => {
      const arch = new THREE.Mesh(new THREE.BoxGeometry(0.40, 0.28, 1.6), bodyMat);
      arch.position.set(px, 0.12, pz);
      g.add(arch);
    });
  });

  // ── headlights
  [[-0.90, 0.0, 1.83], [0.90, 0.0, 1.83]].forEach(([hx, hy, hz]) => {
    const hl_mesh = new THREE.Mesh(new THREE.BoxGeometry(0.38, 0.24, 0.06), glowMat);
    hl_mesh.position.set(hx, hy, hz);
    g.add(hl_mesh);
    const hl = new THREE.PointLight(0xffffff, 1.0, 18);
    hl.position.set(hx, hy + 0.5, hz + 0.8);
    g.add(hl);
  });

  // ── tail lights
  [[-0.90, 0.0, -1.83], [0.90, 0.0, -1.83]].forEach(([tx, ty, tz]) => {
    const tl_mesh = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.22, 0.06), tailMat);
    tl_mesh.position.set(tx, ty, tz);
    g.add(tl_mesh);
  });

  // ── exhaust pipes (cylindrical side pipes)
  [-1.57, 1.57].forEach(px => {
    const ex = new THREE.Mesh(
      new THREE.CylinderGeometry(0.07, 0.07, 1.3, 6), metalMat
    );
    ex.rotation.z = Math.PI / 2;
    ex.position.set(px, -0.04, -0.5);
    g.add(ex);
  });

  g.userData.bodyMat = bodyMat;
  return g;
}

// ─────────────────────────────────────────────────────────────────────────────
//  LOCAL PLAYER (slot assigned by server; defaults to p1 offline)
// ─────────────────────────────────────────────────────────────────────────────
let mySlot    = 'p1';   // 'p1' | 'p2', set once server assigns
let myColor   = 0xff2200;  // red  (p1)
let enemyColor = 0x2266ff; // blue (p2)

const localBuggy = createBuggy(myColor);
scene.add(localBuggy);

const carPos   = P1_SPAWN_POS.clone();
let   carAngle = P1_SPAWN_ANGLE;
let   carSpeed = 0;

// Power-up state (local player)
let activePowerup   = null;
let powerupTimeLeft = 0;

// ─────────────────────────────────────────────────────────────────────────────
//  REMOTE PLAYER
// ─────────────────────────────────────────────────────────────────────────────
const remoteBuggy = createBuggy(enemyColor);
remoteBuggy.visible = false;
scene.add(remoteBuggy);

const remotePos   = new THREE.Vector3();
let   remoteAngle = 0;
let   remoteSpeed = 0;
let   enemyConnected = false;

// ─────────────────────────────────────────────────────────────────────────────
//  COMBAT STATE
// ─────────────────────────────────────────────────────────────────────────────
let myHealth     = PLAYER_HP;
let myFrags      = 0;
let enemyFrags   = 0;
let respawnTimer = 0;     // > 0 while dead
let lastHitTime       = -999;  // for local hit-flash visual
let lastRemoteHitTime = -999;  // for remote buggy hit-flash visual
let lastDamageTime = -999; // cooldown between damage events

// Flash the buggy body white briefly on hit
function triggerHitFlash() {
  lastHitTime = clock.elapsedTime;
}

// Respawn local player
function doRespawn() {
  const sp = mySlot === 'p1' ? P1_SPAWN_POS : P2_SPAWN_POS;
  const sa = mySlot === 'p1' ? P1_SPAWN_ANGLE : P2_SPAWN_ANGLE;
  carPos.copy(sp);
  carAngle  = sa;
  carSpeed  = 0;
  myHealth  = PLAYER_HP;
  respawnTimer = 0;
  document.getElementById('dead-overlay').style.display = 'none';
}

// ─────────────────────────────────────────────────────────────────────────────
//  SOCKET.IO  (gracefully degrade when server is offline)
// ─────────────────────────────────────────────────────────────────────────────
const socket = io({ reconnectionAttempts: 3, timeout: 4000, transports: ['websocket'] });
let socketReady = false;

socket.on('connect', () => {
  socketReady = true;
  document.getElementById('status').textContent = 'CONNECTED — WAITING FOR OPPONENT…';
});

socket.on('connect_error', () => {
  document.getElementById('status').textContent = 'OFFLINE MODE (no server)';
});

socket.on('assigned', (slot) => {
  mySlot = slot;
  if (slot === 'p2') {
    // Swap colours and spawn
    myColor    = 0x2266ff;
    enemyColor = 0xff2200;
    // Update only the body material colour for each buggy
    localBuggy.userData.bodyMat.color.setHex(myColor);
    localBuggy.userData.bodyMat.emissive.setHex(myColor).multiplyScalar(0.06);
    remoteBuggy.userData.bodyMat.color.setHex(enemyColor);
    remoteBuggy.userData.bodyMat.emissive.setHex(enemyColor).multiplyScalar(0.06);
    carPos.copy(P2_SPAWN_POS);
    carAngle = P2_SPAWN_ANGLE;
  }
  document.getElementById('status').textContent = `YOU ARE ${slot.toUpperCase()}  —  WAITING FOR OPPONENT…`;
});

socket.on('peer-joined', () => {
  enemyConnected = true;
  remoteBuggy.visible = true;
  document.getElementById('status').textContent = 'FIGHT!';
  showFlash('FIGHT!');
});

socket.on('peer-left', () => {
  enemyConnected = false;
  remoteBuggy.visible = false;
  document.getElementById('status').textContent = 'OPPONENT LEFT — WAITING…';
});

// Receive remote player's state
socket.on('peer-state', (d) => {
  remotePos.set(d.x, d.y, d.z);
  remoteAngle = d.angle;
  remoteSpeed = d.speed;
});

// Authoritative frag counts from server
socket.on('frags', (f) => {
  if (mySlot === 'p1') { myFrags = f.p1; enemyFrags = f.p2; }
  else                  { myFrags = f.p2; enemyFrags = f.p1; }
});

// Sync building destruction from remote player
socket.on('peer-bricks', (indices) => {
  if (!Array.isArray(indices)) return;
  const affectedBuildings = new Set();
  let newlyDestroyed = 0;
  for (const idx of indices) {
    if (idx >= 0 && idx < bActive.length && bActive[idx]) {
      bActive[idx] = 0;
      _mt.makeScale(0, 0, 0);
      brickIM.setMatrixAt(idx, _mt);
      newlyDestroyed++;
      for (const b of buildings) {
        if (idx >= b.startIdx && idx < b.startIdx + b.cnt) {
          affectedBuildings.add(b);
          break;
        }
      }
    }
  }
  if (newlyDestroyed > 0) {
    brickIM.instanceMatrix.needsUpdate = true;
    for (const b of affectedBuildings) recalcBuildingBounds(b);
    enemyDestroyedBricks += newlyDestroyed;
    destroyedBrickCount  += newlyDestroyed;
    checkAllBuildingsDown();
  }
});

// Throttle state emissions
let lastStateSend = 0;

// ─────────────────────────────────────────────────────────────────────────────
//  INPUT
// ─────────────────────────────────────────────────────────────────────────────
const keys = {};
window.addEventListener('keydown', e => { keys[e.code] = true;  e.preventDefault(); });
window.addEventListener('keyup',   e => { keys[e.code] = false; });
const held = (...codes) => codes.some(c => keys[c]);

// ─────────────────────────────────────────────────────────────────────────────
//  HUD ELEMENTS
// ─────────────────────────────────────────────────────────────────────────────
const elHealthFill = document.getElementById('health-fill');
const elHealthVal  = document.getElementById('health-val');
const elP1Frags    = document.getElementById('p1-frags');
const elP2Frags    = document.getElementById('p2-frags');
const elPwrHud     = document.getElementById('powerup-hud');

function updateHUD() {
  // Health bar
  const pct = Math.max(0, myHealth / PLAYER_HP * 100);
  elHealthFill.style.width = pct + '%';
  elHealthFill.style.background =
    pct > 60 ? '#00ff88' : pct > 30 ? '#ffcc00' : '#ff2200';
  elHealthVal.textContent = Math.ceil(Math.max(0, myHealth));

  // Frags
  if (mySlot === 'p1') {
    elP1Frags.textContent = myFrags;
    elP2Frags.textContent = enemyFrags;
  } else {
    elP1Frags.textContent = enemyFrags;
    elP2Frags.textContent = myFrags;
  }

  // Powerup
  if (activePowerup) {
    const col = '#' + POWERUP_COLS[activePowerup].toString(16).padStart(6, '0');
    elPwrHud.textContent = `${POWERUP_LABELS[activePowerup]}  ${Math.ceil(powerupTimeLeft)}s`;
    elPwrHud.style.color = col;
    elPwrHud.style.textShadow = `0 0 8px ${col}`;
  } else {
    elPwrHud.textContent = '';
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  MINIMAP
// ─────────────────────────────────────────────────────────────────────────────
const mmEl  = /** @type {HTMLCanvasElement} */ (document.getElementById('minimap'));
const mmCtx = mmEl.getContext('2d');
mmEl.width = mmEl.height = 170;
const MM   = 170;
const toMM = (x, z) => [(x - OX) / CITY * MM, (z - OZ) / CITY * MM];

function drawMinimap() {
  mmCtx.clearRect(0, 0, MM, MM);
  // Buildings
  mmCtx.fillStyle = '#223';
  buildings.forEach(b => {
    const [mx, mz] = toMM(b.minX, b.minZ);
    const bw = (b.maxX - b.minX) / CITY * MM;
    const bd = (b.maxZ - b.minZ) / CITY * MM;
    mmCtx.fillRect(mx, mz, bw, bd);
  });
  // Local player
  const [cx, cz] = toMM(carPos.x, carPos.z);
  mmCtx.save();
  mmCtx.translate(cx, cz);
  mmCtx.rotate(carAngle);
  mmCtx.fillStyle = mySlot === 'p1' ? '#ff4422' : '#2266ff';
  mmCtx.beginPath();
  mmCtx.moveTo(0, -6); mmCtx.lineTo(3.5, 4); mmCtx.lineTo(-3.5, 4);
  mmCtx.closePath(); mmCtx.fill();
  mmCtx.restore();
  // Remote player
  if (enemyConnected) {
    const [ex, ez] = toMM(remotePos.x, remotePos.z);
    mmCtx.save();
    mmCtx.translate(ex, ez);
    mmCtx.rotate(remoteAngle);
    mmCtx.fillStyle = mySlot === 'p1' ? '#2266ff' : '#ff4422';
    mmCtx.beginPath();
    mmCtx.moveTo(0, -6); mmCtx.lineTo(3.5, 4); mmCtx.lineTo(-3.5, 4);
    mmCtx.closePath(); mmCtx.fill();
    mmCtx.restore();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  FLASH
// ─────────────────────────────────────────────────────────────────────────────
function showFlash(text) {
  const el = document.getElementById('flash');
  el.textContent = text;
  el.style.opacity = '1';
  setTimeout(() => { el.style.opacity = '0'; }, 2000);
}

let gameOver = false;
function checkAllBuildingsDown() {
  if (gameOver || destroyedBrickCount < totalBricks) return;
  gameOver = true;
  const winner = myDestroyedBricks > enemyDestroyedBricks ? 'YOU WIN!' :
                 enemyDestroyedBricks > myDestroyedBricks ? 'ENEMY WINS!' : "IT'S A DRAW!";
  showFlash('ALL BUILDINGS DOWN! ' + winner);
}

// ─────────────────────────────────────────────────────────────────────────────
//  MAIN LOOP
// ─────────────────────────────────────────────────────────────────────────────
const clock = new THREE.Clock();

function animate() {
  requestAnimationFrame(animate);
  const dt = Math.min(clock.getDelta(), 0.05);

  // ── Dead / respawning ─────────────────────────────────────────────────────
  if (respawnTimer > 0) {
    respawnTimer -= dt;
    if (respawnTimer <= 0) doRespawn();
    renderer.render(scene, camera);
    return;
  }

  // ── Car physics ───────────────────────────────────────────────────────────
  const turning = (held('ArrowLeft', 'KeyA') ? 1 : 0) - (held('ArrowRight', 'KeyD') ? 1 : 0);
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

  const spdMult = activePowerup === 'double_speed' ? 2 : 1;
  carSpeed = Math.max(-MAX_REV * spdMult, Math.min(MAX_FWD * spdMult, carSpeed));

  const prevX = carPos.x, prevZ = carPos.z;
  carPos.x += Math.sin(carAngle) * carSpeed * dt;
  carPos.z += Math.cos(carAngle) * carSpeed * dt;

  const bound = CITY / 2 + 8;
  carPos.x = Math.max(-bound, Math.min(bound, carPos.x));
  carPos.z = Math.max(-bound, Math.min(bound, carPos.z));

  // ── Building collision ────────────────────────────────────────────────────
  const saA = Math.abs(Math.sin(carAngle)), caA = Math.abs(Math.cos(carAngle));
  const pwShrink = activePowerup === 'shrink' ? 0.55 : 1.0;
  const hw = (saA * CAR_L / 2 + caA * CAR_W / 2 + COL_PAD) * pwShrink;
  const hl = (caA * CAR_L / 2 + saA * CAR_W / 2 + COL_PAD) * pwShrink;
  const carMinY = carPos.y - CAR_H / 2;
  const carMaxY = carPos.y + CAR_H / 2;

  for (const b of buildings) {
    if (carPos.x + hw <= b.minX || carPos.x - hw >= b.maxX ||
        carPos.z + hl <= b.minZ || carPos.z - hl >= b.maxZ) continue;
    if (hasActiveBrickInBox(b,
        carPos.x - hw, carPos.x + hw,
        carPos.z - hl, carPos.z + hl,
        carMinY, carMaxY)) {
      if (Math.abs(carSpeed) >= MIN_IMPACT ||
          (activePowerup === 'unstoppable' && Math.abs(carSpeed) > 0.5)) {
        const dir = new THREE.Vector3(Math.sin(carAngle), 0, Math.cos(carAngle));
        const destroyed = detachBricks(b, carPos.x, carPos.z, dir, Math.abs(carSpeed), activePowerup);
        if (destroyed.length > 0) {
          myDestroyedBricks    += destroyed.length;
          destroyedBrickCount  += destroyed.length;
          if (socketReady) socket.emit('bricks', destroyed);
          checkAllBuildingsDown();
        }
      }
      if (activePowerup !== 'unstoppable') {
        carPos.x = prevX;
        carPos.z = prevZ;
        carSpeed *= -0.5;
        break;
      }
    }
  }

  // ── Player-to-player collision ────────────────────────────────────────────
  if (enemyConnected) {
    const dx = carPos.x - remotePos.x;
    const dz = carPos.z - remotePos.z;
    const dist = Math.hypot(dx, dz);

    if (dist < COLL_DIST && dist > 0.1) {
      // World-space velocity vectors
      const myVelX  = Math.sin(carAngle)    * carSpeed;
      const myVelZ  = Math.cos(carAngle)    * carSpeed;
      const remVelX = Math.sin(remoteAngle) * remoteSpeed;
      const remVelZ = Math.cos(remoteAngle) * remoteSpeed;
      // Approach speed: how fast each car is moving toward the other
      // (dx,dz) points from remote to local, so toward-remote = -(dx,dz)
      const myApproach  = Math.max(0, -(myVelX * dx + myVelZ * dz) / dist);
      const remApproach = Math.max(0,  (remVelX * dx + remVelZ * dz) / dist);
      const relSpd = myApproach + remApproach;

      if (relSpd > MIN_DMG_SPEED && activePowerup !== 'unstoppable') {
        // Both clients independently detect this collision, so each flashes
        // the remote buggy on their own screen. Combined with triggerHitFlash()
        // below, both buggies turn white on both players' screens.
        lastRemoteHitTime = clock.elapsedTime;
        if (clock.elapsedTime - lastDamageTime >= DAMAGE_COOLDOWN) {
          lastDamageTime = clock.elapsedTime;
          // Faster attacker (higher approach contribution) takes proportionally less damage
          const dmgFactor = relSpd > 0.5 ? remApproach / relSpd : 0.5;
          const dmg = (relSpd - MIN_DMG_SPEED) * 9 * dmgFactor;
          myHealth -= dmg;
          triggerHitFlash();

          if (myHealth <= 0) {
            myHealth = 0;
            respawnTimer = RESPAWN_SECS;
            document.getElementById('dead-overlay').style.display = 'block';
            showFlash('YOU DIED');
            socket.emit('died');   // server awards frag to enemy
          }

          // Bounce away
          carSpeed *= -0.6;
        }
        // Always revert position on high-speed collision to prevent pass-through
        carPos.x = prevX;
        carPos.z = prevZ;
      } else if (dist < COLL_DIST * 0.6) {
        // Gentle push-apart at low speed
        const push = 0.5;
        carPos.x += (dx / dist) * push;
        carPos.z += (dz / dist) * push;
      }
    }
  }

  // ── Update local buggy mesh ───────────────────────────────────────────────
  localBuggy.position.set(carPos.x, carPos.y, carPos.z);
  localBuggy.rotation.y = carAngle;
  localBuggy.scale.setScalar(activePowerup === 'shrink' ? 0.55 : 1.0);

  // Hit-flash: briefly tint body white then restore — only touches the body paint material
  const hitAge = clock.elapsedTime - lastHitTime;
  if (hitAge < 0.18) {
    localBuggy.userData.bodyMat.color.setHex(0xffffff);
  } else {
    // Restore original body colour (unconditional so a slow frame can never leave it white)
    localBuggy.userData.bodyMat.color.setHex(myColor);
  }

  // ── Update remote buggy ───────────────────────────────────────────────────
  if (enemyConnected) {
    remoteBuggy.position.copy(remotePos);
    remoteBuggy.rotation.y = remoteAngle;
    // Hit-flash: briefly tint remote buggy white when a collision occurs
    const remoteHitAge = clock.elapsedTime - lastRemoteHitTime;
    if (remoteHitAge < 0.18) {
      remoteBuggy.userData.bodyMat.color.setHex(0xffffff);
    } else {
      remoteBuggy.userData.bodyMat.color.setHex(enemyColor);
    }
  }

  // ── Flying brick physics ──────────────────────────────────────────────────
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
      fb.vel.y = Math.abs(fb.vel.y) * 0.35;
      fb.vel.x *= 0.72; fb.vel.z *= 0.72;
      fb.rotVel.multiplyScalar(0.6);
    }
    fb.life -= dt;
    if (fb.life <= 0) { scene.remove(fb.mesh); flyingBricks.splice(i, 1); }
  }

  // ── Powerup physics, collection, timer ───────────────────────────────────
  for (let k = powerupItems.length - 1; k >= 0; k--) {
    const p = powerupItems[k];
    if (!p.landed) {
      p.vy += GRAV * dt;
      p.mesh.position.y += p.vy * dt;
      if (p.mesh.position.y <= 0.7) { p.mesh.position.y = 0.7; p.landed = true; }
    } else {
      p.bobT += dt;
      p.mesh.position.y = 0.7 + Math.sin(p.bobT * 2.5) * 0.25;
      p.mesh.rotation.y += dt * 2.5;
      if (Math.hypot(carPos.x - p.mesh.position.x, carPos.z - p.mesh.position.z) < POWERUP_RADIUS) {
        activePowerup   = p.type;
        powerupTimeLeft = POWERUP_DURATION;
        showFlash(POWERUP_LABELS[p.type] + '!');
        scene.remove(p.mesh);
        powerupItems.splice(k, 1);
      }
    }
  }
  if (activePowerup) {
    powerupTimeLeft -= dt;
    if (powerupTimeLeft <= 0) {
      const wasShrink = activePowerup === 'shrink';
      activePowerup = null;
      if (wasShrink) resolveBuildingOverlap();
    }
  }

  // ── Camera (chase cam behind local player) ────────────────────────────────
  camera.position.set(
    carPos.x - Math.sin(carAngle) * CAM_BACK,
    CAM_H,
    carPos.z - Math.cos(carAngle) * CAM_BACK
  );
  camera.up.set(0, 1, 0);
  camera.lookAt(carPos.x, 0, carPos.z);

  // ── Socket.io state emit (throttled to ~20 Hz) ────────────────────────────
  const now = performance.now();
  if (socketReady && now - lastStateSend > 50) {
    socket.emit('state', {
      x: carPos.x, y: carPos.y, z: carPos.z,
      angle: carAngle,
      speed: carSpeed,
    });
    lastStateSend = now;
  }

  // ── HUD + minimap ─────────────────────────────────────────────────────────
  updateHUD();
  drawMinimap();

  renderer.render(scene, camera);
}

animate();
