// src/game.js — Brick City (multiplayer free-roam deathmatch)
import * as THREE from 'three';
import { io } from 'socket.io-client';

// ─────────────────────────────────────────────────────────────────────────────
//  CONFIGURATION
// ─────────────────────────────────────────────────────────────────────────────
const GRID   = 5;
const BLOCK  = 26;
const STREET = 10;
const CELL   = BLOCK + STREET; // 36
const CITY   = GRID * CELL + STREET; // 190
const OX     = -CITY / 2;
const OZ     = -CITY / 2;

// Brick dimensions
const BW = 2.0, BH = 0.75, BD = 2.0;
const MOR   = 0.10;
const BPAD  = 2.0;
const BFOOT = BLOCK - BPAD * 2; // 22
const NBX   = Math.floor(BFOOT / (BW + MOR)); // 10
const NBZ   = Math.floor(BFOOT / (BD + MOR)); // 10

// Buggy
const BUG_W = 3.0, BUG_L = 4.2, BUG_H = 0.55;
const MAX_FWD = 26, MAX_REV = 8;
const ACCEL = 22, BRAKE_F = 34, FRIC = 3.0, TURN = 2.1;
const COL_PAD = 0.2;

// Physics
const GRAV       = -22;
const MIN_IMPACT = 7;

// Player combat
const MAX_HP             = 100;
const BUGGY_COL_DIST     = 4.2;  // world-units: treat as collision
const RESPAWN_DELAY      = 3.0;
const INVINC_DURATION    = 2.0;
const MAX_COLLISION_DMG  = 50;   // maximum HP loss per collision
const COLLISION_DMG_MULT = 2.8;  // damage = closing speed × this multiplier

// Power-ups
const POWERUP_DURATION    = 8;
const POWERUP_DROP_CHANCE = 0.45;
const POWERUP_RADIUS      = 1.8;
const POWERUP_TYPES  = ['double_speed', 'double_damage', 'shrink', 'unstoppable'];
const POWERUP_COLS   = { double_speed: 0xffdd00, double_damage: 0xff4400, shrink: 0x00aaff, unstoppable: 0x00ff44 };
const POWERUP_LABELS = { double_speed: 'DOUBLE SPEED', double_damage: 'DOUBLE DAMAGE', shrink: 'SHRINK', unstoppable: 'UNSTOPPABLE' };

// Network
const NET_HZ = 20;

// ─────────────────────────────────────────────────────────────────────────────
//  SOCKET.IO
// ─────────────────────────────────────────────────────────────────────────────
const socket = io();

let mySlot       = -1;   // 0 = P1 red, 1 = P2 blue
let peerOnline   = false;
let fragScores   = [0, 0];
let netAccum     = 0;

// DOM refs
const elFlash    = document.getElementById('flash');
const elConnUI   = document.getElementById('connecting');
const elP1Hp     = document.getElementById('p1hp');
const elP1Bar    = document.getElementById('p1bar');
const elP1Frags  = document.getElementById('p1frags');
const elP1Speed  = document.getElementById('p1speed');
const elP1Pwr    = document.getElementById('p1pwr');
const elP2Hp     = document.getElementById('p2hp');
const elP2Bar    = document.getElementById('p2bar');
const elP2Frags  = document.getElementById('p2frags');
const elP2Status = document.getElementById('p2status');

function showFlash(msg) {
  elFlash.textContent = msg;
  elFlash.style.opacity = '1';
  setTimeout(() => { elFlash.style.opacity = '0'; }, 1900);
}
function refreshFragHUD() {
  elP1Frags.textContent = fragScores[0];
  elP2Frags.textContent = fragScores[1];
}

socket.on('connect', () => { elConnUI.textContent = 'Connected — assigning slot…'; });

socket.on('full', () => {
  elConnUI.textContent = 'Server full (max 2 players). Refresh to retry.';
});

socket.on('init', ({ slot, frags }) => {
  mySlot     = slot;
  fragScores = frags;
  elConnUI.style.display = 'none';
  refreshFragHUD();
  // Place local buggy at spawn
  const p = players[mySlot];
  p.pos.copy(spawnPos(mySlot));
  p.angle = mySlot === 0 ? Math.PI / 2 : -Math.PI / 2;
  buggies[mySlot].visible = true;
  showFlash(`YOU ARE PLAYER ${mySlot + 1}`);
});

socket.on('peer_joined', ({ slot }) => {
  peerOnline = true;
  elP2Status.textContent = 'P2 online';
  elP2Hp.textContent = '100';
  elP2Bar.style.width = '100%';
  buggies[slot].visible = true;
  showFlash('P2 JOINED — FIGHT!');
});

socket.on('peer_disconnected', ({ slot }) => {
  peerOnline = false;
  elP2Status.textContent = 'P2 disconnected';
  elP2Hp.textContent = '–';
  elP2Bar.style.width = '0%';
  buggies[slot].visible = false;
});

socket.on('peer_state', ({ slot, x, z, angle, hp, dead }) => {
  const p = players[slot];
  p.pos.set(x, 0.5, z);
  p.angle = angle;
  p.hp    = hp;
  p.dead  = dead;
  // Update peer buggy mesh
  if (dead) {
    buggies[slot].visible = false;
  } else {
    buggies[slot].visible = true;
    buggies[slot].position.set(x, 0.5, z);
    buggies[slot].rotation.y = angle;
  }
  // Update P2 HUD
  if (slot !== mySlot) {
    const pct = Math.max(0, hp) / MAX_HP * 100;
    elP2Hp.textContent     = Math.max(0, Math.round(hp));
    elP2Bar.style.width    = pct + '%';
  }
});

socket.on('frag_update', ({ frags }) => {
  fragScores = frags;
  refreshFragHUD();
});

// ─────────────────────────────────────────────────────────────────────────────
//  RENDERER
// ─────────────────────────────────────────────────────────────────────────────
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type    = THREE.PCFSoftShadowMap;
renderer.toneMapping       = THREE.ACESFilmicToneMapping;
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
scene.fog = new THREE.FogExp2(0x0b0d16, 0.0025);

// ─────────────────────────────────────────────────────────────────────────────
//  CAMERA
// ─────────────────────────────────────────────────────────────────────────────
const camera   = new THREE.PerspectiveCamera(52, window.innerWidth / window.innerHeight, 0.5, 700);
const CAM_H    = 32;
const CAM_BACK = 32;

// ─────────────────────────────────────────────────────────────────────────────
//  LIGHTING
// ─────────────────────────────────────────────────────────────────────────────
scene.add(new THREE.AmbientLight(0x445566, 1.0));

const sun = new THREE.DirectionalLight(0xfff0cc, 1.8);
sun.position.set(80, 150, 60);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
Object.assign(sun.shadow.camera, { left:-200, right:200, top:200, bottom:-200, near:1, far:700 });
scene.add(sun);

[0xff0044, 0x00ffaa, 0xff7700, 0x7700ff, 0x00ccff].forEach((c, i) => {
  const pl = new THREE.PointLight(c, 3.0, 90);
  pl.position.set(Math.cos(i / 5 * Math.PI * 2) * 80, 14,
                  Math.sin(i / 5 * Math.PI * 2) * 80);
  scene.add(pl);
});

// ─────────────────────────────────────────────────────────────────────────────
//  GROUND, ROADS, SIDEWALKS & CURBS
// ─────────────────────────────────────────────────────────────────────────────
// Dark base ground
const gndMesh = new THREE.Mesh(
  new THREE.PlaneGeometry(CITY + 80, CITY + 80),
  new THREE.MeshLambertMaterial({ color: 0x090b12 })
);
gndMesh.rotation.x = -Math.PI / 2;
gndMesh.receiveShadow = true;
scene.add(gndMesh);

const roadMat  = new THREE.MeshLambertMaterial({ color: 0x1e2030 }); // dark asphalt
const paveMat  = new THREE.MeshLambertMaterial({ color: 0x6e6e78 }); // concrete pavement
const curbMat  = new THREE.MeshLambertMaterial({ color: 0x8a8a96 }); // lighter curb

function addPlane(cx, cz, w, d, mat, y = 0.005) {
  const m = new THREE.Mesh(new THREE.PlaneGeometry(w, d), mat);
  m.rotation.x = -Math.PI / 2;
  m.position.set(cx, y, cz);
  m.receiveShadow = true;
  scene.add(m);
}
function addBox(cx, cy, cz, w, h, d, mat) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
  m.position.set(cx, cy, cz);
  m.receiveShadow = true;
  scene.add(m);
}

// Road surfaces
for (let i = 0; i <= GRID; i++) {
  addPlane(0,                          OZ + i * CELL + STREET / 2, CITY,   STREET, roadMat);
  addPlane(OX + i * CELL + STREET / 2, 0,                          STREET, CITY,   roadMat);
}

// White centre-line dashes on every road
const dashMat = new THREE.MeshBasicMaterial({ color: 0xffffff, opacity: 0.30, transparent: true });
function drawDashes(x1, z1, x2, z2) {
  const DASH = 2.5, GAP = 2.0;
  const dx = x2 - x1, dz = z2 - z1;
  const len = Math.hypot(dx, dz);
  const angle = Math.atan2(dx, dz);
  for (let d = 0; d < len; d += DASH + GAP) {
    const dl   = Math.min(DASH, len - d);
    const frac = (d + dl / 2) / len;
    const g = new THREE.PlaneGeometry(0.4, dl);
    g.rotateX(-Math.PI / 2);
    const m = new THREE.Mesh(g, dashMat);
    m.position.set(x1 + dx * frac, 0.012, z1 + dz * frac);
    m.rotation.y = angle;
    scene.add(m);
  }
}
for (let i = 0; i <= GRID; i++) {
  const xm = OX + i * CELL + STREET / 2;
  const zm = OZ + i * CELL + STREET / 2;
  drawDashes(OX, zm, OX + CITY, zm);    // horizontal street dashes
  drawDashes(xm, OZ, xm, OZ + CITY);   // vertical street dashes
}

// Pavement slabs + kerb lips around every building block
const KERB_H = 0.16, KERB_W = 0.4;
for (let bi = 0; bi < GRID; bi++) {
  for (let bj = 0; bj < GRID; bj++) {
    const bcx = OX + bj * CELL + STREET + BLOCK / 2;
    const bcz = OZ + bi * CELL + STREET + BLOCK / 2;
    // Pavement (fills the full block area at slightly elevated y)
    addPlane(bcx, bcz, BLOCK, BLOCK, paveMat, 0.02);
    // Kerb boxes — thin raised edges around the pavement
    const half = BLOCK / 2;
    addBox(bcx,        KERB_H / 2, bcz - half, BLOCK + KERB_W * 2, KERB_H, KERB_W, curbMat);
    addBox(bcx,        KERB_H / 2, bcz + half, BLOCK + KERB_W * 2, KERB_H, KERB_W, curbMat);
    addBox(bcx - half, KERB_H / 2, bcz,        KERB_W, KERB_H, BLOCK, curbMat);
    addBox(bcx + half, KERB_H / 2, bcz,        KERB_W, KERB_H, BLOCK, curbMat);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  BUILDINGS — varied types, different palettes, instanced bricks
// ─────────────────────────────────────────────────────────────────────────────
const PALETTE_VIVID = [
  0xff1155, 0xff6600, 0xffdd00, 0x00ff88, 0x00aaff,
  0xaa00ff, 0xff44bb, 0x33ffee, 0xff9922, 0x22ccff,
  0xffcc00, 0x00ff44, 0xff2299, 0x44ffaa, 0x88ff00,
];
const PALETTE_GLASS = [0x4488cc, 0x44aacc, 0x336699, 0x88aacc, 0x99bbdd];
const PALETTE_EARTH = [0xcc8844, 0xaa7733, 0xdd9955, 0xbb8844, 0xddbb88];
const PALETTE_MONO  = [0x555566, 0x666677, 0x778899, 0x445566, 0x667788];

function rndOf(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

// Building descriptors
const buildings = [];
let totalBricks  = 0;

// Building type definitions: { flMin, flMax, bxPad, bzPad, palette }
const BLDG_DEFS = [
  { type: 'standard', flMin: 4, flMax: 14, bxPad: 0, bzPad: 0, pal: PALETTE_VIVID },
  { type: 'tower',    flMin: 12, flMax: 22, bxPad: 2, bzPad: 2, pal: PALETTE_GLASS },
  { type: 'slab',     flMin: 3, flMax: 7,  bxPad: 0, bzPad: 3, pal: PALETTE_MONO  },
  { type: 'bungalow', flMin: 1, flMax: 3,  bxPad: 1, bzPad: 1, pal: PALETTE_EARTH },
];

for (let bi = 0; bi < GRID; bi++) {
  for (let bj = 0; bj < GRID; bj++) {
    const def = rndOf(BLDG_DEFS);
    const floors = def.flMin + Math.floor(Math.random() * (def.flMax - def.flMin + 1));
    const bcx = OX + bj * CELL + STREET + BLOCK / 2;
    const bcz = OZ + bi * CELL + STREET + BLOCK / 2;

    // Active brick sub-grid for this building type
    const bxS = def.bxPad, bxE = NBX - def.bxPad;
    const bzS = def.bzPad, bzE = NBZ - def.bzPad;
    const baseMinX = bcx - BFOOT / 2;
    const baseMinZ = bcz - BFOOT / 2;

    buildings.push({
      cx: bcx, cz: bcz, floors,
      bxS, bxE, bzS, bzE,
      pal: def.pal,
      // Tight AABB (only covers the active brick footprint)
      minX: baseMinX + bxS * (BW + MOR),
      maxX: baseMinX + bxE * (BW + MOR) - MOR,
      minZ: baseMinZ + bzS * (BD + MOR),
      maxZ: baseMinZ + bzE * (BD + MOR) - MOR,
      startIdx: totalBricks,
    });
    totalBricks += NBX * NBZ * floors;
  }
}

const brickGeo = new THREE.BoxGeometry(BW - MOR, BH - MOR, BD - MOR);
{
  const n = brickGeo.attributes.position.count;
  brickGeo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(n * 3).fill(1), 3));
}
const brickMat = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.88, vertexColors: true, depthWrite: true });
const brickIM  = new THREE.InstancedMesh(brickGeo, brickMat, totalBricks);
brickIM.castShadow   = true;
brickIM.frustumCulled = false;

const bActive = new Uint8Array(totalBricks).fill(1);
const _mt = new THREE.Matrix4();
const _ct = new THREE.Color();

buildings.forEach(b => {
  let idx = b.startIdx;
  const baseMinX = b.cx - BFOOT / 2;
  const baseMinZ = b.cz - BFOOT / 2;
  for (let fl = 0; fl < b.floors; fl++) {
    const colA = rndOf(b.pal);
    const colB = rndOf(b.pal);
    for (let rz = 0; rz < NBZ; rz++) {
      for (let bx = 0; bx < NBX; bx++) {
        const inFootprint = (bx >= b.bxS && bx < b.bxE && rz >= b.bzS && rz < b.bzE);
        if (inFootprint) {
          const wx = baseMinX + bx * (BW + MOR) + BW / 2;
          const wy = fl * (BH + MOR) + BH / 2;
          const wz = baseMinZ + rz * (BD + MOR) + BD / 2;
          _mt.setPosition(wx, wy, wz);
          brickIM.setMatrixAt(idx, _mt);
          _ct.setHex((bx + rz) % 2 === 0 ? colA : colB);
          brickIM.setColorAt(idx, _ct);
        } else {
          // Outside footprint — mark inactive and hide
          bActive[idx] = 0;
          _mt.makeScale(0, 0, 0);
          brickIM.setMatrixAt(idx, _mt);
          _ct.setHex(0x000000);
          brickIM.setColorAt(idx, _ct);
        }
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
const flyMats = PALETTE_VIVID.map(hex =>
  new THREE.MeshBasicMaterial({ color: hex, transparent: true, opacity: 0.90 })
);
const flyGeo = new THREE.BoxGeometry(BW - MOR, BH - MOR, BD - MOR);
{
  const n = flyGeo.attributes.position.count;
  flyGeo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(n * 3).fill(1), 3));
}
const flyingBricks = [];

function detachBricks(building, impactX, impactZ, dir, force, powerup) {
  // Shrink powerup → much smaller blast radius
  const RADIUS = powerup === 'double_damage' ? 14
               : powerup === 'shrink'        ? 3
               :                               7;
  const MAX_DETACH = 160;
  let detached = 0;
  let idx = building.startIdx;

  const baseMinX = building.cx - BFOOT / 2;
  const baseMinZ = building.cz - BFOOT / 2;

  for (let fl = 0; fl < building.floors && detached < MAX_DETACH; fl++) {
    for (let rz = 0; rz < NBZ && detached < MAX_DETACH; rz++) {
      for (let bx = 0; bx < NBX && detached < MAX_DETACH; bx++) {
        if (!bActive[idx]) { idx++; continue; }

        const wx   = baseMinX + bx * (BW + MOR) + BW / 2;
        const wz   = baseMinZ + rz * (BD + MOR) + BD / 2;
        const dist = Math.hypot(wx - impactX, wz - impactZ);

        if (dist < RADIUS) {
          _mt.makeScale(0, 0, 0);
          brickIM.setMatrixAt(idx, _mt);
          bActive[idx] = 0;

          const wy  = fl * (BH + MOR) + BH / 2;
          const mat = flyMats[Math.floor(Math.random() * flyMats.length)];
          const mesh = new THREE.Mesh(flyGeo, mat);
          mesh.position.set(wx, wy, wz);
          mesh.castShadow = true;
          scene.add(mesh);

          const spread = () => (Math.random() - 0.5) * 6;
          const fwd    = force * 0.4 + Math.random() * 3;
          flyingBricks.push({
            mesh,
            vel: new THREE.Vector3(
              dir.x * fwd + spread(), Math.random() * 9 + 3, dir.z * fwd + spread()
            ),
            rotVel: new THREE.Vector3(
              (Math.random() - 0.5) * 8, (Math.random() - 0.5) * 8, (Math.random() - 0.5) * 8
            ),
            life: 6 + Math.random() * 3,
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

    // Chance to drop a power-up
    if (Math.random() < POWERUP_DROP_CHANCE) {
      const type  = rndOf(POWERUP_TYPES);
      const pMesh = new THREE.Mesh(
        new THREE.BoxGeometry(1.4, 1.4, 1.4),
        new THREE.MeshBasicMaterial({ color: POWERUP_COLS[type] })
      );
      pMesh.position.set(impactX + (Math.random() - 0.5) * 4, 8, impactZ + (Math.random() - 0.5) * 4);
      scene.add(pMesh);
      powerupItems.push({ mesh: pMesh, type, vy: 0, landed: false, bobT: 0 });
    }
  }
}

function recalcBuildingBounds(building) {
  const baseMinX = building.cx - BFOOT / 2;
  const baseMinZ = building.cz - BFOOT / 2;
  let idx = building.startIdx;
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
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
    building.minX = minX; building.maxX = maxX; building.minZ = minZ; building.maxZ = maxZ;
  } else {
    building.minX = building.maxX = building.cx; building.minZ = building.maxZ = building.cz;
  }
}

function hasActiveBrickInBox(building, minX, maxX, minZ, maxZ, minY, maxY) {
  const baseMinX = building.cx - BFOOT / 2;
  const baseMinZ = building.cz - BFOOT / 2;
  for (let fl = 0; fl < building.floors; fl++) {
    const flMinY = fl * (BH + MOR), flMaxY = flMinY + BH;
    if (flMaxY <= minY || flMinY >= maxY) continue;
    for (let rz = 0; rz < NBZ; rz++) {
      const wz = baseMinZ + rz * (BD + MOR) + BD / 2;
      if (wz + BD / 2 <= minZ || wz - BD / 2 >= maxZ) continue;
      for (let bx = 0; bx < NBX; bx++) {
        const wx = baseMinX + bx * (BW + MOR) + BW / 2;
        if (wx + BW / 2 <= minX || wx - BW / 2 >= maxX) continue;
        const idx = building.startIdx + fl * NBZ * NBX + rz * NBX + bx;
        if (bActive[idx]) return true;
      }
    }
  }
  return false;
}

// ─────────────────────────────────────────────────────────────────────────────
//  LAMPPOSTS  (made entirely from cube geometry)
// ─────────────────────────────────────────────────────────────────────────────
const lampPoleMat = new THREE.MeshPhongMaterial({ color: 0x888898, shininess: 80 });
const lampBulbMat = new THREE.MeshBasicMaterial({ color: 0xffe8a0 });
const POLE_H = 5.5;

function addLamppost(x, z) {
  // Base
  const base = new THREE.Mesh(new THREE.BoxGeometry(0.55, 0.4, 0.55), lampPoleMat);
  base.position.set(x, 0.2, z);
  scene.add(base);
  // Pole
  const pole = new THREE.Mesh(new THREE.BoxGeometry(0.22, POLE_H, 0.22), lampPoleMat);
  pole.position.set(x, 0.4 + POLE_H / 2, z);
  scene.add(pole);
  // Horizontal arm (pointing into street)
  const arm = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.16, 1.3), lampPoleMat);
  arm.position.set(x, 0.4 + POLE_H, z + 0.65);
  scene.add(arm);
  // Lamp housing
  const housing = new THREE.Mesh(new THREE.BoxGeometry(0.55, 0.28, 0.55), lampPoleMat);
  housing.position.set(x, 0.4 + POLE_H - 0.14, z + 1.3);
  scene.add(housing);
  // Glowing bulb
  const bulb = new THREE.Mesh(new THREE.BoxGeometry(0.38, 0.20, 0.38), lampBulbMat);
  bulb.position.set(x, 0.4 + POLE_H - 0.14, z + 1.3);
  scene.add(bulb);
  // Point light
  const pl = new THREE.PointLight(0xffe0a0, 1.6, 26);
  pl.position.set(x, 0.4 + POLE_H, z + 1.5);
  scene.add(pl);
}

// One lamppost per corner of each building block
buildings.forEach(b => {
  const half = BLOCK / 2 - 0.8;
  [[-half, -half], [half, -half], [-half, half], [half, half]].forEach(([ox, oz]) => {
    addLamppost(b.cx + ox, b.cz + oz);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
//  BUGGY MODEL  (shiny off-road buggy with cube roll-cage)
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Build a Three.js Group representing a shiny off-road buggy.
 * @param {number} bodyHex   – hex colour for main body and tail-lights
 * @param {number} accentHex – hex colour for roll cage, wheel hubs, and trim
 * @returns {THREE.Group}
 */
function buildBuggy(bodyHex, accentHex) {
  const g = new THREE.Group();

  const bodyMat  = new THREE.MeshPhongMaterial({ color: bodyHex,   shininess: 240, specular: 0xffffff });
  const rollMat  = new THREE.MeshPhongMaterial({ color: accentHex, shininess: 160 });
  const wheelMat = new THREE.MeshPhongMaterial({ color: 0x1a1a1a,  shininess: 40  });
  const hubMat   = new THREE.MeshPhongMaterial({ color: accentHex, shininess: 200 });
  const darkMat  = new THREE.MeshPhongMaterial({ color: 0x111111 });
  const hlMat    = new THREE.MeshBasicMaterial({ color: 0xffffaa });
  const tlMat    = new THREE.MeshBasicMaterial({ color: bodyHex   });

  // Main hull
  const hull = new THREE.Mesh(new THREE.BoxGeometry(BUG_W, BUG_H, BUG_L), bodyMat);
  hull.castShadow = true;
  g.add(hull);

  // Front nose plate
  const nose = new THREE.Mesh(new THREE.BoxGeometry(BUG_W * 0.72, BUG_H * 0.7, 0.65), bodyMat);
  nose.position.set(0, -0.02, BUG_L / 2 + 0.32);
  nose.castShadow = true;
  g.add(nose);

  // Rear plate
  const rear = new THREE.Mesh(new THREE.BoxGeometry(BUG_W * 0.82, BUG_H * 0.72, 0.65), bodyMat);
  rear.position.set(0, -0.02, -(BUG_L / 2 + 0.32));
  g.add(rear);

  // Underbody chassis
  const chassis = new THREE.Mesh(new THREE.BoxGeometry(BUG_W * 0.88, 0.12, BUG_L * 0.94), darkMat);
  chassis.position.set(0, -BUG_H / 2 - 0.06, 0);
  g.add(chassis);

  // ── Roll cage ────────────────────────────────────────────────────
  const POST_H = 1.55;
  const postY  = BUG_H / 2 + POST_H / 2;
  const postX  = BUG_W * 0.41;
  const postZ  = BUG_L * 0.27;
  const postGeo = new THREE.BoxGeometry(0.13, POST_H, 0.13);
  [[-postX, postZ], [postX, postZ], [-postX, -postZ], [postX, -postZ]].forEach(([px, pz]) => {
    const post = new THREE.Mesh(postGeo, rollMat);
    post.position.set(px, postY, pz);
    g.add(post);
  });
  // Top cross-bars
  const topBarGeo = new THREE.BoxGeometry(BUG_W * 0.83, 0.11, 0.11);
  [postZ, -postZ].forEach(pz => {
    const bar = new THREE.Mesh(topBarGeo, rollMat);
    bar.position.set(0, BUG_H / 2 + POST_H, pz);
    g.add(bar);
  });
  // Side rails
  const sideGeo = new THREE.BoxGeometry(0.11, 0.11, postZ * 2);
  [-postX, postX].forEach(px => {
    const rail = new THREE.Mesh(sideGeo, rollMat);
    rail.position.set(px, BUG_H / 2 + POST_H, 0);
    g.add(rail);
  });

  // Driver seat hint
  const seat = new THREE.Mesh(new THREE.BoxGeometry(0.85, 0.18, 0.65), darkMat);
  seat.position.set(0, BUG_H / 2 + 0.09, 0.1);
  g.add(seat);

  // ── Big wheels ───────────────────────────────────────────────────
  const wGeo  = new THREE.CylinderGeometry(0.68, 0.68, 0.44, 14);
  const hubGeo = new THREE.BoxGeometry(0.42, 0.42, 0.42);
  const WX = BUG_W / 2 + 0.38, WY = -0.22;
  [[-WX, WY, BUG_L * 0.30], [WX, WY, BUG_L * 0.30],
   [-WX, WY, -BUG_L * 0.30], [WX, WY, -BUG_L * 0.30]].forEach(([wx, wy, wz]) => {
    const wheel = new THREE.Mesh(wGeo, wheelMat);
    wheel.rotation.z = Math.PI / 2;
    wheel.position.set(wx, wy, wz);
    wheel.castShadow = true;
    g.add(wheel);
    const hub = new THREE.Mesh(hubGeo, hubMat);
    hub.position.set(wx, wy, wz);
    g.add(hub);
  });

  // Fender flares (box-style)
  const fGeo = new THREE.BoxGeometry(0.32, 0.26, 0.95);
  const fMat = new THREE.MeshPhongMaterial({ color: bodyHex, shininess: 80 });
  [[-WX + 0.12, WY + 0.1, BUG_L * 0.30], [WX - 0.12, WY + 0.1, BUG_L * 0.30],
   [-WX + 0.12, WY + 0.1, -BUG_L * 0.30], [WX - 0.12, WY + 0.1, -BUG_L * 0.30]].forEach(([fx, fy, fz]) => {
    g.add(Object.assign(new THREE.Mesh(fGeo, fMat), { position: new THREE.Vector3(fx, fy, fz) }));
  });

  // Headlights
  [[-0.82, 0.04, BUG_L / 2 + 0.65], [0.82, 0.04, BUG_L / 2 + 0.65]].forEach(([hx, hy, hz]) => {
    const hl = new THREE.Mesh(new THREE.BoxGeometry(0.40, 0.20, 0.09), hlMat);
    hl.position.set(hx, hy, hz);
    g.add(hl);
    const pl = new THREE.PointLight(0xffffff, 0.6, 12);
    pl.position.set(hx, hy + 0.4, hz + 0.7);
    g.add(pl);
  });

  // Tail-lights
  [[-0.82, 0.04, -(BUG_L / 2 + 0.65)], [0.82, 0.04, -(BUG_L / 2 + 0.65)]].forEach(([tx, ty, tz]) => {
    const tl = new THREE.Mesh(new THREE.BoxGeometry(0.40, 0.20, 0.09), tlMat);
    tl.position.set(tx, ty, tz);
    g.add(tl);
  });

  return g;
}

// Two buggies: P1 = shiny red, P2 = shiny blue
const buggies = [
  buildBuggy(0xff1a00, 0xcc1500),
  buildBuggy(0x0055ff, 0x0033cc),
];
buggies[0].visible = false;
buggies[1].visible = false;
scene.add(buggies[0]);
scene.add(buggies[1]);

// ─────────────────────────────────────────────────────────────────────────────
//  PLAYER STATE
// ─────────────────────────────────────────────────────────────────────────────
function spawnPos(slot) {
  // P1 near top-left, P2 near bottom-right — both on road surfaces
  return slot === 0
    ? new THREE.Vector3(OX + STREET * 1.5, 0.5, OZ + STREET * 1.5)
    : new THREE.Vector3(OX + CITY - STREET * 1.5, 0.5, OZ + CITY - STREET * 1.5);
}

const players = [
  { pos: spawnPos(0).clone(), angle: 0,        speed: 0, hp: MAX_HP, dead: false, respawnT: 0, invincT: 0, powerup: null, pwrT: 0 },
  { pos: spawnPos(1).clone(), angle: Math.PI,  speed: 0, hp: MAX_HP, dead: false, respawnT: 0, invincT: 0, powerup: null, pwrT: 0 },
];

// ─────────────────────────────────────────────────────────────────────────────
//  POWER-UP ITEMS
// ─────────────────────────────────────────────────────────────────────────────
const powerupItems = [];

// ─────────────────────────────────────────────────────────────────────────────
//  INPUT
// ─────────────────────────────────────────────────────────────────────────────
const keys = {};
window.addEventListener('keydown', e => { keys[e.code] = true;  e.preventDefault(); });
window.addEventListener('keyup',   e => { keys[e.code] = false; });
const held = (...codes) => codes.some(c => keys[c]);

// ─────────────────────────────────────────────────────────────────────────────
//  MINIMAP
// ─────────────────────────────────────────────────────────────────────────────
const mmEl  = document.getElementById('minimap');
const mmCtx = mmEl.getContext('2d');
mmEl.width  = 170;
mmEl.height = 170;
const MM   = 170;
const toMM = (x, z) => [(x - OX) / CITY * MM, (z - OZ) / CITY * MM];

function drawMinimap() {
  mmCtx.clearRect(0, 0, MM, MM);

  // Building footprints
  mmCtx.fillStyle = '#334';
  buildings.forEach(b => {
    const baseMinX = b.cx - BFOOT / 2;
    const baseMinZ = b.cz - BFOOT / 2;
    const [mx, mz] = toMM(baseMinX + b.bxS * (BW + MOR), baseMinZ + b.bzS * (BD + MOR));
    const bw = (b.bxE - b.bxS) * (BW + MOR) / CITY * MM;
    const bd = (b.bzE - b.bzS) * (BD + MOR) / CITY * MM;
    mmCtx.fillRect(mx, mz, bw, bd);
  });

  // Buggy blips
  players.forEach((p, i) => {
    if (mySlot === -1) return;
    if (i !== mySlot && !peerOnline) return;
    if (p.dead) return;
    const [cx, cz] = toMM(p.pos.x, p.pos.z);
    mmCtx.save();
    mmCtx.translate(cx, cz);
    mmCtx.rotate(p.angle);
    mmCtx.fillStyle = i === 0 ? '#ff3300' : '#3399ff';
    mmCtx.beginPath(); mmCtx.moveTo(0, -5); mmCtx.lineTo(3, 4); mmCtx.lineTo(-3, 4);
    mmCtx.closePath(); mmCtx.fill();
    mmCtx.restore();
  });
}

// ─────────────────────────────────────────────────────────────────────────────
//  MAIN LOOP
// ─────────────────────────────────────────────────────────────────────────────
const clock = new THREE.Clock();

function animate() {
  requestAnimationFrame(animate);
  const dt = Math.min(clock.getDelta(), 0.05);

  if (mySlot !== -1) {
    const p = players[mySlot];

    if (!p.dead) {
      // ── Drive ──────────────────────────────────────────────────────────────
      const turning = (held('ArrowLeft', 'KeyA') ? 1 : 0) - (held('ArrowRight', 'KeyD') ? 1 : 0);
      if (Math.abs(p.speed) > 0.4) p.angle += turning * TURN * Math.sign(p.speed) * dt;

      if (held('ArrowUp', 'KeyW')) {
        p.speed += ACCEL * dt;
      } else if (held('ArrowDown', 'KeyS') || held('Space')) {
        p.speed > 0 ? (p.speed -= BRAKE_F * dt) : (p.speed -= ACCEL * 0.5 * dt);
      } else {
        const drag = FRIC * dt;
        p.speed = Math.abs(p.speed) < drag ? 0 : p.speed - Math.sign(p.speed) * drag;
      }
      const spdMult = p.powerup === 'double_speed' ? 2 : 1;
      p.speed = Math.max(-MAX_REV * spdMult, Math.min(MAX_FWD * spdMult, p.speed));

      const prevX = p.pos.x, prevZ = p.pos.z;
      p.pos.x += Math.sin(p.angle) * p.speed * dt;
      p.pos.z += Math.cos(p.angle) * p.speed * dt;

      // City boundary clamp
      const bound = CITY / 2 + 4;
      p.pos.x = Math.max(-bound, Math.min(bound, p.pos.x));
      p.pos.z = Math.max(-bound, Math.min(bound, p.pos.z));

      // ── Building collision ──────────────────────────────────────────────────
      const saA = Math.abs(Math.sin(p.angle)), caA = Math.abs(Math.cos(p.angle));
      const sc  = p.powerup === 'shrink' ? 0.55 : 1.0;
      const hw  = (saA * BUG_L / 2 + caA * BUG_W / 2 + COL_PAD) * sc;
      const hl  = (caA * BUG_L / 2 + saA * BUG_W / 2 + COL_PAD) * sc;
      const minY = p.pos.y - BUG_H / 2, maxY = p.pos.y + BUG_H / 2;

      for (const b of buildings) {
        if (p.pos.x + hw <= b.minX || p.pos.x - hw >= b.maxX ||
            p.pos.z + hl <= b.minZ || p.pos.z - hl >= b.maxZ) continue;

        if (hasActiveBrickInBox(b, p.pos.x - hw, p.pos.x + hw, p.pos.z - hl, p.pos.z + hl, minY, maxY)) {
          if (Math.abs(p.speed) >= MIN_IMPACT || (p.powerup === 'unstoppable' && Math.abs(p.speed) > 0.5)) {
            const dir = new THREE.Vector3(Math.sin(p.angle), 0, Math.cos(p.angle));
            detachBricks(b, p.pos.x, p.pos.z, dir, Math.abs(p.speed), p.powerup);
          }
          if (p.powerup !== 'unstoppable') {
            p.pos.x = prevX; p.pos.z = prevZ;
            p.speed *= -0.7;
            break;
          }
        }
      }

      // ── Player-vs-player collision ──────────────────────────────────────────
      if (peerOnline && p.invincT <= 0) {
        const them = players[1 - mySlot];
        if (!them.dead) {
          const dx   = p.pos.x - them.pos.x;
          const dz   = p.pos.z - them.pos.z;
          const dist = Math.hypot(dx, dz);
          if (dist < BUGGY_COL_DIST) {
            const relSpd = Math.abs(p.speed) + Math.abs(them.speed);
            if (relSpd > 2.5) {
              const dmg = Math.min(MAX_COLLISION_DMG, relSpd * COLLISION_DMG_MULT);
              p.hp -= dmg;
              p.speed *= -0.55;
              if (dist > 0.01) {
                p.pos.x += (dx / dist) * (BUGGY_COL_DIST - dist + 0.2) * 0.5;
                p.pos.z += (dz / dist) * (BUGGY_COL_DIST - dist + 0.2) * 0.5;
              }
              if (p.hp <= 0 && !p.dead) {
                p.dead = true;
                p.respawnT = RESPAWN_DELAY;
                buggies[mySlot].visible = false;
                socket.emit('killed');
                showFlash('YOU WERE FRAGGED!');
              }
            }
          }
        }
      }

      if (p.invincT > 0) p.invincT -= dt;

      // ── Power-up pickup ─────────────────────────────────────────────────────
      for (let i = powerupItems.length - 1; i >= 0; i--) {
        const pw = powerupItems[i];
        if (!pw.landed) {
          pw.vy += GRAV * dt;
          pw.mesh.position.y += pw.vy * dt;
          if (pw.mesh.position.y <= 0.7) { pw.mesh.position.y = 0.7; pw.landed = true; }
        } else {
          pw.bobT += dt;
          pw.mesh.position.y = 0.7 + Math.sin(pw.bobT * 2.5) * 0.25;
          pw.mesh.rotation.y += dt * 2.5;
          if (Math.hypot(p.pos.x - pw.mesh.position.x, p.pos.z - pw.mesh.position.z) < POWERUP_RADIUS) {
            p.powerup = pw.type;
            p.pwrT    = POWERUP_DURATION;
            showFlash(POWERUP_LABELS[pw.type] + '!');
            scene.remove(pw.mesh);
            powerupItems.splice(i, 1);
          }
        }
      }
      if (p.powerup) {
        p.pwrT -= dt;
        if (p.pwrT <= 0) p.powerup = null;
      }

      // ── Update local buggy mesh ─────────────────────────────────────────────
      buggies[mySlot].position.set(p.pos.x, p.pos.y, p.pos.z);
      buggies[mySlot].rotation.y = p.angle;
      buggies[mySlot].scale.setScalar(p.powerup === 'shrink' ? 0.55 : 1.0);

      // ── P1 HUD ──────────────────────────────────────────────────────────────
      const hpPct = Math.max(0, p.hp) / MAX_HP * 100;
      elP1Hp.textContent    = Math.max(0, Math.round(p.hp));
      elP1Bar.style.width   = hpPct + '%';
      elP1Speed.textContent = Math.round(Math.abs(p.speed) * 3.6);
      if (p.powerup) {
        const col = '#' + POWERUP_COLS[p.powerup].toString(16).padStart(6, '0');
        elP1Pwr.textContent       = POWERUP_LABELS[p.powerup] + '  ' + Math.ceil(p.pwrT) + 's';
        elP1Pwr.style.color       = col;
        elP1Pwr.style.textShadow  = `0 0 8px ${col}`;
      } else {
        elP1Pwr.textContent = '';
      }

      // ── Camera ──────────────────────────────────────────────────────────────
      camera.position.set(
        p.pos.x - Math.sin(p.angle) * CAM_BACK,
        CAM_H,
        p.pos.z - Math.cos(p.angle) * CAM_BACK
      );
      camera.up.set(0, 1, 0);
      camera.lookAt(p.pos.x, 0, p.pos.z);

    } else {
      // ── Respawn countdown ───────────────────────────────────────────────────
      p.respawnT -= dt;
      if (p.respawnT <= 0) {
        p.dead   = false;
        p.hp     = MAX_HP;
        p.invincT = INVINC_DURATION;
        p.speed  = 0;
        p.pos.copy(spawnPos(mySlot));
        p.angle  = mySlot === 0 ? Math.PI / 2 : -Math.PI / 2;
        buggies[mySlot].visible = true;
        showFlash('RESPAWNED');
      }
    }

    // ── Send state to peer ───────────────────────────────────────────────────
    netAccum += dt;
    if (netAccum >= 1 / NET_HZ) {
      netAccum = 0;
      socket.emit('state', { x: p.pos.x, z: p.pos.z, angle: p.angle, hp: p.hp, dead: p.dead });
    }
  }

  // ── Flying brick physics ────────────────────────────────────────────────────
  let fi = flyingBricks.length;
  while (fi--) {
    const fb = flyingBricks[fi];
    fb.vel.y += GRAV * dt;
    fb.mesh.position.addScaledVector(fb.vel, dt);
    fb.mesh.rotation.x += fb.rotVel.x * dt;
    fb.mesh.rotation.y += fb.rotVel.y * dt;
    fb.mesh.rotation.z += fb.rotVel.z * dt;
    if (fb.mesh.position.y < 0.3) {
      fb.mesh.position.y = 0.3;
      fb.vel.y  = Math.abs(fb.vel.y) * 0.35;
      fb.vel.x *= 0.72; fb.vel.z *= 0.72;
      fb.rotVel.multiplyScalar(0.6);
    }
    fb.life -= dt;
    if (fb.life <= 0) { scene.remove(fb.mesh); flyingBricks.splice(fi, 1); }
  }

  drawMinimap();
  renderer.render(scene, camera);
}

animate();
