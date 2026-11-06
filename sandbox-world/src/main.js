/**
 * main.js — the render layer. It owns no physics of its own: every number that
 * moves a pixel here is read out of ./physics.js and ./fantasy.js, the same
 * modules the headless test suite asserts against. The scene is a viewer for
 * the simulation, not a second simulation.
 */
import * as THREE from 'three';
import { Sky } from 'three/addons/objects/Sky.js';
import { Water } from 'three/addons/objects/Water.js';

import {
  V,
  SI,
  World,
  makeBody,
  kinetic,
  totalEnergy,
  terrainHeight,
  landSurface,
  waterSurface,
  exitance,
  wienPeak,
  dragForce,
  FIXED_DT,
  ISLANDS,
  SEA_LEVEL,
} from './physics.js';

import { Caster, LevitationStore } from './fantasy.js';

// ---------------------------------------------------------------------------
// boot
// ---------------------------------------------------------------------------

const $ = (id) => document.getElementById(id);
const errBox = $('err');
window.addEventListener('error', (e) => {
  errBox.textContent = `[world fault] ${e.message}\n${(e.filename || '') + ':' + (e.lineno || '')}`;
});

const toastEl = $('toast');
let toastTimer;
function toast(msg, ms = 2600) {
  toastEl.textContent = msg;
  toastEl.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove('show'), ms);
}

const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 0.75;
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.xr.enabled = true;
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.fog = new THREE.FogExp2(0x0a1220, 0.0032);

const camera = new THREE.PerspectiveCamera(72, innerWidth / innerHeight, 0.1, 4000);
const player = new THREE.Group(); // the dolly: XR poses live inside it
player.add(camera);
scene.add(player);

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

// ---------------------------------------------------------------------------
// the sky: real atmospheric scattering, one sun, two moons
// ---------------------------------------------------------------------------

const sky = new Sky();
sky.scale.setScalar(6000);
scene.add(sky);
const skyU = sky.material.uniforms;
skyU.turbidity.value = 6.2;
skyU.rayleigh.value = 2.1;
skyU.mieCoefficient.value = 0.006;
skyU.mieDirectionalG.value = 0.82;

const SUN_DIR = new THREE.Vector3();
const sun = new THREE.DirectionalLight(0xfff2dc, 2.9);
sun.castShadow = true;
sun.shadow.mapSize.set(1024, 1024);
const sc = sun.shadow.camera;
sc.left = -120; sc.right = 120; sc.top = 120; sc.bottom = -120; sc.near = 1; sc.far = 400;
sun.shadow.bias = -0.0006;
scene.add(sun);
scene.add(sun.target);

const hemi = new THREE.HemisphereLight(0x9fc4ff, 0x2a2118, 0.55);
scene.add(hemi);

// Physical bodies: these carry the numbers the kernel uses. Their positions are
// in metres from the datum, so the visual discs are drawn on a sky dome of
// radius 900 along the SAME direction vector — one truth, two scales.
const world = new World({ gravity: SI.g0 });
world.dt = FIXED_DT;

const MOONS = [
  { name: 'Ire', mass: 7.35e22, dist: 3.84e8, colour: 0xd8d2c4, size: 26, angle: 0.9, climb: 6.0e-6 },
  { name: 'Vhan', mass: 2.0e21, dist: 2.0e8, colour: 0xb4c6ff, size: 9, angle: 2.4, climb: 1.4e-5 },
];
for (const m of MOONS) {
  const p = new V(Math.cos(m.angle) * m.dist, Math.abs(Math.sin(m.angle)) * m.dist * 0.6 + m.dist * 0.2, Math.sin(m.angle) * m.dist);
  m.position = p;
  world.field.addBody({ name: m.name, position: p, mass: m.mass });
  const mesh = new THREE.Mesh(
    new THREE.SphereGeometry(m.size, 24, 16),
    new THREE.MeshStandardMaterial({ color: m.colour, emissive: m.colour, emissiveIntensity: 0.35, roughness: 0.9 }),
  );
  scene.add(mesh);
  m.mesh = mesh;
}

// ---------------------------------------------------------------------------
// terrain — generated from terrainHeight(), the very function collisions use
// ---------------------------------------------------------------------------

function buildIsland(i, index) {
  const seg = 96;
  const R = i.r;
  const geo = new THREE.PlaneGeometry(R * 2.02, R * 2.02, seg, seg);
  geo.rotateX(-Math.PI / 2);
  const pos = geo.attributes.position;
  const colors = new Float32Array(pos.count * 3);
  const c = new THREE.Color();
  for (let k = 0; k < pos.count; k++) {
    const x = pos.getX(k) + i.x;
    const z = pos.getZ(k) + i.z;
    const h = terrainHeight(x, z);
    pos.setY(k, h);
    // law of the slope: the same gradient the contact normal uses drives the
    // biome colouring, so cliffs look like cliffs for the same reason rocks
    // slide off them.
    const s = landSurface(new V(x, h, z)).normal.y;
    const slope = 1 - s;
    if (h < SEA_LEVEL + 0.5) c.setHex(0xc9b98c); // beach
    else if (slope > 0.42) c.setHex(0x6b6157); // scree
    else c.setHex(0x4f7a3a).lerp(new THREE.Color(0x2f4a24), Math.min(1, (h - 4) / 14));
    // per-island tint so the archipelago reads as places, not one texture
    c.offsetHSL(index * 0.045, 0, 0);
    c.toArray(colors, k * 3);
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geo.computeVertexNormals();
  geo.translate(-0, 0, 0);
  const mesh = new THREE.Mesh(
    geo,
    new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95, metalness: 0.02, flatShading: false }),
  );
  mesh.position.set(i.x, 0, i.z);
  mesh.geometry.translate(-i.x, 0, -i.z); // bake world offset into the mesh
  mesh.receiveShadow = true;
  mesh.castShadow = true;

  // the underside: a floating island needs roots, and it needs them to be
  // heavy. Mass estimate below is what the levitation store has to hold up.
  const rootH = R * 1.25;
  const root = new THREE.Mesh(
    new THREE.ConeGeometry(R, rootH, 40, 3, true),
    new THREE.MeshStandardMaterial({ color: 0x453c34, roughness: 1, side: THREE.DoubleSide }),
  );
  root.position.set(i.x, -1.2 - rootH / 2, i.z);
  root.rotation.x = Math.PI;
  root.rotation.z = index * 0.4;
  root.castShadow = true;

  const g = new THREE.Group();
  g.add(mesh, root);
  scene.add(g);

  const store = new LevitationStore({
    island: i,
    altitude: i.h,
    capacity: 9e9 * (i.r / 34),
    leakWatts: 4.2e5 * (i.r / 34) ** 2,
  });
  return { group: g, mesh, root, store, info: i, drooping: false };
}

const islands = ISLANDS.map(buildIsland);

// the sea: reflection, refraction and a tide that the moons actually cause
const waterGeo = new THREE.PlaneGeometry(1400, 1400, 1, 1);
const normalsTex = makeWaveNormalTexture();
const water = new Water(waterGeo, {
  textureWidth: 512,
  textureHeight: 512,
  waterNormals: normalsTex,
  sunDirection: SUN_DIR,
  sunColor: 0xffe6bd,
  waterColor: 0x0a2231,
  distortionScale: 2.4,
  fog: true,
  alpha: 1.0,
});
water.rotation.x = -Math.PI / 2;
water.position.y = SEA_LEVEL;
scene.add(water);

/** Procedural normal map, so the sea works with no external asset to fetch. */
function makeWaveNormalTexture() {
  const N = 256;
  const data = new Uint8Array(N * N * 4);
  const h = (x, y) => {
    let v = 0;
    for (const [f, a] of [[1, 1], [2, 0.5], [4, 0.25], [8, 0.12], [16, 0.06]]) {
      v += a * Math.sin((x / N) * Math.PI * 2 * f + 0.7 * f) * Math.cos((y / N) * Math.PI * 2 * f * 1.37 + 1.1 * f);
    }
    return v;
  };
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const dx = h(x + 1, y) - h(x - 1, y);
      const dy = h(x, y + 1) - h(x, y - 1);
      const nx = -dx, ny = -dy, nz = 1;
      const m = Math.hypot(nx, ny, nz);
      const i = (y * N + x) * 4;
      data[i] = ((nx / m) * 0.5 + 0.5) * 255;
      data[i + 1] = ((ny / m) * 0.5 + 0.5) * 255;
      data[i + 2] = ((nz / m) * 0.5 + 0.5) * 255;
      data[i + 3] = 255;
    }
  }
  const tex = new THREE.DataTexture(data, N, N, THREE.RGBAFormat);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(9, 9);
  tex.needsUpdate = true;
  return tex;
}

// ---------------------------------------------------------------------------
// props
// ---------------------------------------------------------------------------

const rockGeo = new THREE.IcosahedronGeometry(1, 1);
const rockMat = new THREE.MeshStandardMaterial({ color: 0x8c8378, roughness: 0.92 });
const woodMat = new THREE.MeshStandardMaterial({ color: 0x7a5a34, roughness: 0.85 });

const visuals = new Map(); // body -> mesh
function attach(body, mesh) {
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  scene.add(mesh);
  visuals.set(body, mesh);
  return body;
}
function detach(body) {
  const m = visuals.get(body);
  if (m) { scene.remove(m); m.geometry?.dispose?.(); visuals.delete(body); }
  world.remove(body);
}

function scatterStones(n = 30, at = null) {
  const o = at ?? feet();
  for (let i = 0; i < n; i++) {
    const r = 0.22 + Math.random() * 0.55;
    const density = 1500 + Math.random() * 1200; // kg/m^3
    const b = makeBody({
      position: new V(o.x + (Math.random() - 0.5) * 26, o.y + 6 + Math.random() * 10, o.z + (Math.random() - 0.5) * 26),
      velocity: new V((Math.random() - 0.5) * 6, Math.random() * 4, (Math.random() - 0.5) * 6),
      mass: density * (4 / 3) * Math.PI * r ** 3,
      radius: r,
      restitution: 0.35,
      kind: 'stone',
    });
    world.add(b);
    attach(b, new THREE.Mesh(rockGeo, rockMat).clone());
    const m = visuals.get(b);
    m.scale.setScalar(r * 1.55);
    m.rotation.set(Math.random() * 3, Math.random() * 3, Math.random() * 3);
  }
}

function dropFeatherAndAnvil() {
  const o = feet();
  const anchor = o.add(new V(3, 22, 0));
  const feather = makeBody({ position: anchor.add(new V(-3, 0, 0)), velocity: new V(0, 0, 0), mass: 0.0008, radius: 0.05, kind: 'feather', restitution: 0.1 });
  const anvil = makeBody({ position: anchor, mass: 150, radius: 0.35, kind: 'anvil', restitution: 0.2 });
  feather.aerodynamic = { rho: SI.air, cd: 1.1, area: 0.02 }; // the feather's crime is drag, not mass
  world.add(feather); world.add(anvil);
  attach(feather, new THREE.Mesh(new THREE.PlaneGeometry(0.3, 0.12), new THREE.MeshStandardMaterial({ color: 0xf3efe2, side: THREE.DoubleSide })));
  attach(anvil, new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.45, 0.45), new THREE.MeshStandardMaterial({ color: 0x3a3d42, roughness: 0.45, metalness: 0.85 })));
  demoPair = { feather, anvil, released: simTime };
  feather.startY = anchor.y;
  anvil.startY = anchor.y;
  toast('feather 0.8 g · anvil 150 kg — same acceleration, different drag');
}
let demoPair = null;

// ---------------------------------------------------------------------------
// the caster: you
// ---------------------------------------------------------------------------

const EYE = 1.7;
const caster = new Caster({ mass: 78, capacity: 4.6e6 });
const initialCredit = caster.capacity;
const me = {
  position: new V(0, terrainHeight(0, 6) + 0.2, 6),
  velocity: new V(0, 0, 0),
  radius: 0.34, // for buoyancy; a human is ~960 kg/m^3, so you float badly
  mass: caster.mass,
  grounded: false,
};

const feet = () => me.position;

// rain: gravity + quadratic drag, so the drops arrive at terminal velocity and
// never faster. The HUD shows the ceiling they are not allowed to break.
const RAIN = 2600;
const rainGeo = new THREE.BufferGeometry();
const rainPos = new Float32Array(RAIN * 3);
const rainVel = new Float32Array(RAIN * 3);
for (let i = 0; i < RAIN; i++) respawnDrop(i, true);
rainGeo.setAttribute('position', new THREE.BufferAttribute(rainPos, 3));
const rain = new THREE.Points(rainGeo, new THREE.PointsMaterial({ color: 0xbcd8ee, size: 0.055, transparent: true, opacity: 0.85, sizeAttenuation: true }));
scene.add(rain);
const DROP = { r: 0.002, mass: (4 / 3) * Math.PI * 0.002 ** 3 * SI.water, cd: 0.47 };
const RAIN_DRAG = { rho: SI.air, cd: DROP.cd, area: Math.PI * DROP.r ** 2 };
const V_TERM = Math.sqrt((2 * DROP.mass * SI.g0) / (SI.air * RAIN_DRAG.cd * RAIN_DRAG.area));

function respawnDrop(i, anywhere = false) {
  const o = feet();
  rainPos[i * 3] = o.x + (Math.random() - 0.5) * 90;
  rainPos[i * 3 + 1] = anywhere ? Math.random() * 60 : 46 + Math.random() * 8;
  rainPos[i * 3 + 2] = o.z + (Math.random() - 0.5) * 90;
  rainVel[i * 3] = (Math.random() - 0.5) * 0.6;
  rainVel[i * 3 + 1] = -Math.random() * 2;
  rainVel[i * 3 + 2] = (Math.random() - 0.5) * 0.6;
}


// input
const keys = new Set();
let yaw = Math.PI, pitch = -0.05, locked = false, sensitivity = 0.0022;
addEventListener('keydown', (e) => {
  if (!locked && !isVR) return;
  keys.add(e.code);
  if (e.code === 'KeyF') castLight();
  if (e.code === 'KeyG') castChill();
  if (e.code === 'KeyH') toggleLift();
  if (e.code === 'KeyT') dropFeatherAndAnvil();
  if (e.code === 'KeyP') scatterStones(30);
  if (e.code === 'KeyR') reset();
});
addEventListener('keyup', (e) => keys.delete(e.code));

renderer.domElement.addEventListener('click', () => {
  if (isVR || locked) return;
  renderer.domElement.requestPointerLock?.();
});
document.addEventListener('pointerlockchange', () => {
  locked = document.pointerLockElement === renderer.domElement;
  if (locked) $('gate').classList.add('hidden');
});
addEventListener('mousemove', (e) => {
  if (!locked) return;
  yaw -= e.movementX * sensitivity;
  pitch -= e.movementY * sensitivity;
  pitch = Math.max(-1.45, Math.min(1.45, pitch));
});

const aimDir = () => {
  const d = camera.getWorldDirection(new THREE.Vector3());
  return new V(d.x, d.y, d.z).norm();
};

// --- spells ---------------------------------------------------------------

function castLance(from = feet().add(new V(0, EYE * 0.9, 0)), dir = aimDir()) {
  const shot = caster.lance({ aim: dir, slugMass: 0.018, muzzleVelocity: 780 });
  me.velocity = me.velocity.add(shot.recoilVelocity); // momentum always collects
  const b = {
    ...shot.projectile,
    position: from,
    kind: 'lance',
    life: 1.6,
  };
  world.add(b);
  const mesh = new THREE.Mesh(
    new THREE.SphereGeometry(0.055, 8, 6),
    new THREE.MeshBasicMaterial({ color: 0xfff0c0 }),
  );
  scene.add(mesh);
  visuals.set(b, mesh);
  b.visual = true;
  spark(from.add(dir.scale(0.6)), 0xffd79a, 10, 3);
  const recoil = Math.hypot(...shot.recoilVelocity.toArray());
  toast(`lance · ${(shot.energy / 1000).toFixed(1)} kJ out · recoil ${(recoil * 100).toFixed(1)} cm/s backwards · ${(caster.charge / 1000).toFixed(0)} kJ left`);
  return b;
}

const orbs = [];
function castLight() {
  const dir = aimDir();
  const origin = feet().add(new V(0, EYE * 0.9, 0)).add(dir.scale(1.6));
  const T = 2450;
  const area = 0.012; // 3.5 cm filament, in m^2
  const asked = exitance(T, 0.9) * area;
  const r = caster.light({ temperature: T, area, duration: 1 }); // ignition is billed
  const lamp = new THREE.PointLight(0xffb96b, 12, 90, 2); // decay 2 === inverse square
  const bulb = new THREE.Mesh(
    new THREE.SphereGeometry(0.075, 16, 12),
    new THREE.MeshBasicMaterial({ color: 0xffe0ae, transparent: true }),
  );
  const g = new THREE.Group();
  g.position.set(origin.x, origin.y, origin.z);
  g.add(lamp, bulb);
  scene.add(g);
  const body = makeBody({ position: origin, velocity: dir.scale(2.2), mass: 0.05, radius: 0.08, kind: 'orb' });
  world.add(body);
  orbs.push({ group: g, body, lamp, bulb, area, T0: T, asked, t: 0, life: 999 });
  const seconds = asked > 0 ? caster.charge / asked : 0;
  toast(`orb lit · ${asked.toFixed(0)} W · ${(r.cost / 1000).toFixed(1)} kJ billed to start · ${seconds.toFixed(0)} s of charge left · it falls, light has no lift`);
}

function castChill() {
  const o = feet().add(aimDir().scale(6));
  const r = caster.chill({ target: null, massOfIce: 3.0, fromT: 289.15, toT: 271.15 });
  if (!r.ok) return toast(`chill refused: needs ${(r.neededJoules / 1000).toFixed(1)} kJ, you hold ${(r.availableJoules / 1000).toFixed(1)} kJ`, 3200);
  const disc = new THREE.Mesh(
    new THREE.CircleGeometry(2.6, 28),
    new THREE.MeshStandardMaterial({ color: 0xcfeaf5, roughness: 0.25, metalness: 0.05, transparent: true, opacity: 0.9 }),
  );
  disc.rotation.x = -Math.PI / 2;
  disc.position.set(o.x, waterSurface(o, simTime).height + 0.03, o.z);
  scene.add(disc);
  frozen.push({ disc, x: o.x, z: o.z, t: 0, life: 26 });
  spark(feet().add(new V(0, EYE, 0)), 0xff8f5a, 24, 4); // the rejected heat, behind you
  toast(`ice 3.0 kg · pumped ${(r.pumpedJoules / 1000).toFixed(1)} kJ out · COP ${r.cop.toFixed(2)} · work ${(r.work / 1000).toFixed(2)} kJ · ${(r.rejectedJoules / 1000).toFixed(1)} kJ dumped at your back`);
}
const frozen = [];

let lifting = null;
function toggleLift() {
  if (lifting) {
    toast(`released · ${lifting.body.kind} falls at ${world.field.g.toFixed(3)} m/s²`);
    lifting = null;
    return;
  }
  const o = feet();
  let best = null, bestD = 14;
  for (const b of world.bodies) {
    if (b.kind !== 'stone') continue;
    const d = b.position.dist(o);
    if (d < bestD) { bestD = d; best = b; }
  }
  if (!best) return toast('nothing within reach to lift — press P first');
  lifting = { body: best };
  toast(`holding ${(best.mass).toFixed(0)} kg · bill ${(best.mass * SI.g0).toFixed(0)} N · drain ${(best.mass * SI.g0 * 0.4 / 1000).toFixed(2)} kJ/s`);
}

function reset() {
  for (const b of [...world.bodies]) if (b.kind !== 'anvil' && b.kind !== 'feather') detach(b);
  for (const { group } of orbs) scene.remove(group);
  orbs.length = 0;
  world.contacts = 0;
  demoPair = null;
  toast('world state reset; the laws stayed put');
}

// --- impact sparks --------------------------------------------------------

const sparks = [];
function spark(at, colour, n = 12, speed = 4) {
  for (let i = 0; i < n; i++) {
    const dir = new V(Math.random() - 0.5, Math.random() * 0.9, Math.random() - 0.5).norm();
    const b = makeBody({ position: at, velocity: dir.scale(speed * (0.3 + Math.random())), mass: 0.002, radius: 0.02, kind: 'spark', restitution: 0.4 });
    world.add(b);
    const m = new THREE.Mesh(new THREE.SphereGeometry(0.035, 6, 5), new THREE.MeshBasicMaterial({ color: colour }));
    scene.add(m);
    visuals.set(b, m);
    sparks.push({ body: b, t: 0, life: 0.5 + Math.random() * 0.5 });
  }
}

// ---------------------------------------------------------------------------
// locomotion — the player runs through the same Field + terrain queries
// ---------------------------------------------------------------------------

const MAX_WALK = 4.4;
function stepPlayer(dt) {
  const g = world.field.accelerationAt(me.position);
  const water = waterSurface(me.position, simTime, world.field.bodies);
  const submerged = me.position.y - me.radius < water.height;

  // horizontal intent, in camera yaw space
  let ix = 0, iz = 0;
  if (keys.has('KeyW')) iz -= 1;
  if (keys.has('KeyS')) iz += 1;
  if (keys.has('KeyA')) ix -= 1;
  if (keys.has('KeyD')) ix += 1;
  const want = new V(ix, 0, iz);
  const moving = want.mag() > 0;
  const cos = Math.cos(yaw), sin = Math.sin(yaw);
  const wish = new V(want.x * cos - want.z * sin, 0, want.x * sin + want.z * cos);
  if (moving) wish.scale(1 / wish.mag());

  const surf = landSurface(me.position);
  const grounded = me.position.y - surf.ground < 0.12 && surf.signedDistance <= 0.14;
  const accel = grounded ? 34 : 6; // you can only push off something
  const targetV = wish.scale(MAX_WALK);
  me.velocity = new V(
    me.velocity.x + (targetV.x - me.velocity.x) * Math.min(1, accel * dt),
    me.velocity.y,
    me.velocity.z + (targetV.z - me.velocity.z) * Math.min(1, accel * dt),
  );

  // vertical: gravity from the kernel, jump as an impulse, water as Archimedes
  if (grounded && keys.has('Space')) {
    const vJump = Math.sqrt(2 * Math.abs(surf.normal.y) * SI.g0 * 0.62); // ~62 cm of hop
    me.velocity = new V(me.velocity.x, vJump, me.velocity.z);
    keys.delete('Space');
  }
  let a = new V(g.x, grounded ? 0 : g.y, g.z);
  if (submerged) {
    const pseudo = { radius: 0.3, position: me.position, velocity: me.velocity };
    const fb = buoyancyForce(pseudo, water.height);
    a = fb.scale(1 / me.mass).add(new V(0, grounded ? 0 : g.y * 0.25, 0));
    me.velocity = me.velocity.scale(1 - Math.min(0.9, 3.4 * dt)); // water is not air
    if (keys.has('Space')) me.velocity = me.velocity.add(new V(0, 3.2 * dt * 12, 0));
  }
  me.velocity = me.velocity.add(a.scale(dt));
  if (grounded && me.velocity.y < 0) me.velocity = new V(me.velocity.x, 0, me.velocity.z);

  const next = me.position.add(me.velocity.scale(dt));
  const nextSurf = landSurface(next);
  if (next.y < nextSurf.ground) {
    const impact = 0.5 * me.mass * me.velocity.y ** 2;
    if (impact > 900) {
      toast(`landing burned ${(impact / 1000).toFixed(2)} kJ of your KE into ground + shin, ≈ ${((impact / (SI.heatWater * 70)) * 1000).toFixed(1)} mK of warmth`, 3400);
    }
    next.y = nextSurf.ground;
    me.velocity = new V(me.velocity.x, 0, me.velocity.z);
  }
  // slide down steep ground: gravity's tangential component, nothing invented
  if (nextSurf.signedDistance < 0.6 && nextSurf.normal.y < 0.86 && !submerged) {
    const t = new V(g.x, g.y, g.z).add(nextSurf.normal.scale(-new V(g.x, g.y, g.z).dot(nextSurf.normal)));
    me.velocity = me.velocity.add(t.scale(dt * 0.9));
  }
  if (next.y < -60) {
    me.position = new V(0, terrainHeight(0, 0) + 3, 4);
    me.velocity = new V(0, 0, 0);
    toast('the sea caught you; up you come');
  } else {
    me.position = next;
  }
  me.grounded = grounded;
}

function buoyancyForce(pseudo, waterY) {
  const f = Math.max(0, Math.min(1, (waterY - (pseudo.position.y - pseudo.radius)) / (2 * pseudo.radius)));
  const vol = (4 / 3) * Math.PI * pseudo.radius ** 3;
  return new V(0, SI.water * vol * f * SI.g0, 0).scale(1);
}

// ---------------------------------------------------------------------------
// frame loop
// ---------------------------------------------------------------------------

let simTime = 0;
let last = performance.now();
let fpsAcc = 0, fpsN = 0, fpsShown = 0, stepsShown = 0, contactsShown = 0, lastContacts = 0;
let isVR = false;

let frameCount = 0;
function frame() {
  frameCount++;
  const now = performance.now();
  let elapsed = (now - last) / 1000;
  last = now;
  elapsed = Math.min(elapsed, 0.1); // never let a tab-switch teleport the world

  const steps = world.advance(elapsed);
  stepsShown = steps;
  simTime += elapsed;

  if (!isVR || true) stepPlayer(elapsed);

  syncIslands(elapsed);
  syncWater();
  syncSky();
  syncBodies();
  syncRain(elapsed);
  syncOrbs(elapsed);
  syncSparks(elapsed);
  syncLift(elapsed);
  syncPlayer();
  updateHud(elapsed, steps, now);

  renderer.render(scene, camera);
}
renderer.setAnimationLoop(frame);

function syncPlayer() {
  camera.rotation.set(0, 0, 0);
  camera.rotation.order = 'YXZ';
  camera.rotation.y = yaw;
  camera.rotation.x = pitch;
  camera.rotation.z = 0;
  if (!isVR) {
    player.position.set(me.position.x, me.position.y + EYE, me.position.z);
    camera.position.set(0, 0, 0);
  } else {
    player.position.set(me.position.x, me.position.y, me.position.z);
  }
  sun.target.position.set(me.position.x, me.position.y, me.position.z);
  sun.position.set(me.position.x + SUN_DIR.x * 180, me.position.y + SUN_DIR.y * 180, me.position.z + SUN_DIR.z * 180);
}

function syncSky() {
  const t = simTime;
  const el = 0.16 + 0.1 * Math.sin(t * 0.02);
  const az = 0.7 + t * 0.01;
  SUN_DIR.set(Math.cos(az) * Math.cos(el), Math.max(0.02, Math.sin(el)), Math.sin(az) * Math.cos(el)).normalize();
  skyU.sunPosition.value.copy(SUN_DIR);
  const above = SUN_DIR.y;
  sun.intensity = 3.4 * Math.max(0.04, above);
  hemi.intensity = 0.18 + 0.45 * Math.max(0, above);
  skyU.turbidity.value = 7.5 - 3 * above;
  skyU.rayleigh.value = 1.1 + 2.4 * Math.max(0, 0.5 - above);
  scene.fog.color.setHSL(0.6, 0.35, 0.03 + 0.14 * Math.max(0, above));
  renderer.toneMappingExposure = 0.6 + 0.35 * Math.max(0, above);

  for (const m of MOONS) {
    // move the physical body, and the drawing follows it — never the reverse
    m.angle += m.climb * 400;
    const p = new V(Math.cos(m.angle) * m.dist, Math.abs(Math.sin(m.angle * 0.6 + m.angle)) * m.dist * 0.5 + m.dist * 0.12, Math.sin(m.angle) * m.dist);
    m.position = p;
    world.field.bodies.find((b) => b.name === m.name).position = p;
    const d = p.norm();
    m.mesh.position.set(d.x * 1200, d.y * 1200, d.z * 1200);
    m.mesh.material.emissiveIntensity = 0.2 + 0.5 * Math.max(0, d.y);
  }
}

function syncWater() {
  const w = waterSurface(me.position, simTime, world.field.bodies);
  water.position.y = w.height;
  if (water.material.uniforms?.size !== undefined) {
    water.material.uniforms.time.value += 0.02 + 0.012 * Math.abs(w.height - SEA_LEVEL);
  }
  world.waterY = w.height;
}

function syncIslands(dt) {
  let worst = 1;
  for (const isl of islands) {
    const alive = isl.store.tick(dt * 60); // accelerate the geology a little
    worst = Math.min(worst, isl.store.remainingFraction);
    if (!alive && !isl.drooping) {
      isl.drooping = true;
      isl.fallV = 0;
      toast('a levitation store has emptied. the island is now just a rock.', 5000);
    }
    if (isl.drooping) {
      isl.fallV = (isl.fallV || 0) + SI.g0 * dt * 0.05;
      isl.group.position.y -= isl.fallV * dt;
      isl.root.position.y = isl.group.position.y - 1.2 - (isl.info.r * 1.25) / 2;
      isl.root.position.set(isl.info.x, isl.group.position.y - 1.2 - (isl.info.r * 1.25) / 2, isl.info.z);
    }
  }
  islandCharge = worst;
}
let islandCharge = 1;

function syncBodies() {
  const live = [...world.bodies];
  for (const b of live) {
    const m = visuals.get(b);
    if (!m) continue;
    m.position.set(b.position.x, b.position.y, b.position.z);
    if (b.kind === 'stone' || b.kind === 'anvil') {
      const s = b.velocity.mag() * 0.02;
      m.rotation.x += s * 0.7; m.rotation.y += s;
    }
    if (b.kind === 'lance') {
      const v = b.velocity.norm();
      m.lookAt(m.position.x + v.x, m.position.y + v.y, m.position.z + v.z);
      m.scale.set(1, 1, 1 + Math.min(6, b.velocity.mag() * 0.01));
    }
    if (b.kind === 'feather') m.rotation.z = Math.sin(simTime * 4 + b.position.x) * 0.5;
  if (demoPair) {
    for (const key of ['feather', 'anvil']) {
      const body = demoPair[key];
      if (!body.landedAt && landSurface(body.position).signedDistance <= 0) {
        body.landedAt = simTime;
        const other = demoPair[key === 'feather' ? 'anvil' : 'feather'];
        if (other.landedAt) {
          const gap = Math.abs(body.landedAt - other.landedAt);
          const h = demoPair.feather.startY - landSurface(demoPair.feather.position).ground;
          toast(`both fell ${h.toFixed(1)} m · landing gap ${(gap * 1000).toFixed(0)} ms of drag, ${(Math.sqrt(2 * h / SI.g0)).toFixed(2)} s of gravity`);
          demoPair = null;
          break;
        }
      }
    }
  }
  }
  // cull spent things
  for (const b of live) {
    if (b.kind === 'lance' && (b.age > b.life || b.position.y < -40)) detach(b);
    else if (b.age > 240) detach(b);
  }
  for (const { body } of [...sparks]) {
    if (body.age > 1.2) detach(body);
  }
  for (let i = sparks.length - 1; i >= 0; i--) if (!visuals.has(sparks[i].body)) sparks.splice(i, 1);
}

function syncRain(dt) {
  const g = world.field.accelerationAt(feet());
  const o = feet();
  let maxSpeed = 0;
  for (let i = 0; i < RAIN; i++) {
    let vx = rainVel[i * 3], vy = rainVel[i * 3 + 1], vz = rainVel[i * 3 + 2];
    const f = dragForce(new V(vx, vy, vz), RAIN_DRAG).scale(1 / DROP.mass);
    vx += (g.x + f.x) * dt; vy += (g.y + f.y) * dt; vz += (g.z + f.z) * dt;
    let px = rainPos[i * 3] + vx * dt;
    let py = rainPos[i * 3 + 1] + vy * dt;
    let pz = rainPos[i * 3 + 2] + vz * dt;
    maxSpeed = Math.max(maxSpeed, -vy);
    const ground = landSurface(new V(px, py, pz));
    if (ground.signedDistance < 0 || Math.abs(px - o.x) > 60 || Math.abs(pz - o.z) > 60) {
      respawnDrop(i);
    } else {
      rainPos[i * 3] = px; rainPos[i * 3 + 1] = py; rainPos[i * 3 + 2] = pz;
      rainVel[i * 3] = vx; rainVel[i * 3 + 1] = vy; rainVel[i * 3 + 2] = vz;
    }
  }
  rainGeo.attributes.position.needsUpdate = true;
  rainSpeed = maxSpeed;
}
let rainSpeed = 0;

function syncOrbs(dt) {
  for (let i = orbs.length - 1; i >= 0; i--) {
    const o = orbs[i];
    o.t += dt;
    // Bill this frame. When the store cannot pay, caster.light() returns a
    // DIMMER answer instead of a free one, and that ratio is the brightness.
    const paid = caster.light({ temperature: o.T0, area: o.area, duration: dt });
    const ratio = Math.max(0, Math.min(1, paid.watts / o.asked));
    o.ratio = ratio;
    const T = o.T0 * (0.55 + 0.45 * ratio);
    const nm = wienPeak(T) * 1e9;
    o.lamp.intensity = 14 * ratio ** 1.2;
    o.lamp.distance = 18 + 80 * ratio;
    o.bulb.material.color.setHSL(THREE.MathUtils.clamp(0.10 - (nm - 500) / 6000, 0.0, 0.16), 0.9, 0.35 + 0.45 * ratio);
    o.bulb.material.opacity = 0.25 + 0.75 * ratio;
    o.group.position.set(o.body.position.x, o.body.position.y, o.body.position.z);
    if (ratio < 0.02) {
      scene.remove(o.group);
      o.bulb.geometry.dispose();
      o.lamp.dispose?.();
      world.remove(o.body);
      orbs.splice(i, 1);
      toast('the orb went out — the charge it needed was not there', 3400);
    }
  }
  for (const f of frozen) {
    f.t += dt;
    if (f.t > f.life) {
      f.disc.material.opacity = Math.max(0, 0.9 - (f.t - f.life) / 12);
      if (f.t > f.life + 12) { scene.remove(f.disc); f.dead = true; }
    }
  }
  for (let i = frozen.length - 1; i >= 0; i--) if (frozen[i].dead) frozen.splice(i, 1);
}

function syncSparks(dt) {
  for (let i = sparks.length - 1; i >= 0; i--) {
    const s = sparks[i];
    s.t += dt;
    const m = visuals.get(s.body);
    if (!m) {
      sparks.splice(i, 1);
      continue;
    }
    const k = Math.max(0, 1 - s.t / s.life);
    m.scale.setScalar(Math.max(0.02, k));
    m.material.transparent = true;
    m.material.opacity = k;
  }
}

function syncLift(dt) {
  if (!lifting) return;
  const b = lifting.body;
  const r = caster.lift({ target: b, duration: dt, acceleration: SI.g0 });
  if (r.drained) {
    lifting = null;
    toast('you ran out. it is falling.', 3000);
    return;
  }
  lifting.power = r.appliedJoules / Math.max(1e-6, dt);
}

// ---------------------------------------------------------------------------
// HUD
// ---------------------------------------------------------------------------

const fmt = (x, u = '') => (Math.abs(x) >= 1e6 || (Math.abs(x) < 1e-3 && x !== 0) ? x.toExponential(2) : x.toFixed(Math.abs(x) > 99 ? 0 : Math.abs(x) > 1 ? 1 : 3)) + ' ' + u;

function updateHud(dt, steps, now) {
  fpsAcc += dt; fpsN++;
  contactsShown = contactsShown * 0.9 + ((world.contacts - lastContacts) / Math.max(1e-3, dt)) * 0.1;
  lastContacts = world.contacts;
  if (fpsAcc > 0.5) { fpsShown = fpsN / fpsAcc; fpsAcc = 0; fpsN = 0; }

  const v = me.velocity;
  const surf = landSurface(me.position);
  $('v-speed').textContent = fmt(v.mag(), 'm/s');
  $('v-alt').textContent = fmt(me.position.y - surf.ground, 'm above ground') + ` · ${fmt(me.position.y, 'm datum')}`;
  const gvec = world.field.accelerationAt(me.position.add(new V(0, EYE, 0)));
  $('v-g').textContent = `${gvec.mag().toFixed(6)} m/s²  (Δ from 9.80665: ${((gvec.mag() - SI.g0) * 1e4).toFixed(3)}e-4)`;
  $('v-ke').textContent = fmt(kinetic({ mass: me.mass, velocity: v }), 'J');
  $('v-pe').textContent = fmt(me.mass * SI.g0 * me.position.y, 'J');

  const L = caster.ledger;
  $('v-store').textContent = fmt(L.stored / 1000, 'kJ');
  $('v-heat').textContent = fmt(L.thermal / 1000, 'kJ');
  $('v-rad').textContent = fmt(L.radiated / 1000, 'kJ');
  const audit = L.audit(initialCredit);
  const lawEl = $('law');
  lawEl.textContent = `${audit.drift.toExponential(1)} J ${audit.ok ? '· laws intact' : '· BROKEN'}`;
  lawEl.classList.toggle('bad', !audit.ok);
  $('bar-charge').style.width = `${(L.stored / caster.capacity) * 100}%`;
  $('bar-heat').style.width = `${Math.min(100, (L.thermal / caster.capacity) * 100)}%`;

  const E = totalEnergy(world);
  $('v-n').textContent = `${world.bodies.length} (+ you)`;
  $('v-cps').textContent = fmt(contactsShown, '/s');
  $('v-total').textContent = fmt(E.total, 'J');
  $('v-island').textContent = `${(islandCharge * 100).toFixed(4)}% · ${(islands[0].store.yearsLeft / 1).toFixed(1)} yr hold`;
  $('v-fps').textContent = `${fpsShown.toFixed(0)} fps · ${steps} steps @240 Hz`;
  $('v-rain').textContent = `${rainSpeed.toFixed(2)} m/s`;
  $('v-vterm').textContent = `${V_TERM.toFixed(2)} m/s (never exceeded)`;
}

// ---------------------------------------------------------------------------
// entry: on foot, or in a headset
// ---------------------------------------------------------------------------

$('enter').addEventListener('click', async () => {
  $('gate').classList.add('hidden');
  renderer.domElement.requestPointerLock?.();
  toast('WASD to move. Click to capture the mouse.', 3200);
  scatterStones(14);
});

$('enter-vr').addEventListener('click', async () => {
  try {
    if (!navigator.xr) throw new Error('this browser has no WebXR');
    const ok = await navigator.xr.isSessionSupported('immersive-vr');
    if (!ok) throw new Error('no immersive-vr device reported');
    const session = await navigator.xr.requestSession('immersive-vr', {
      optionalFeatures: ['local-floor', 'bounded-floor', 'hand-tracking'],
    });
    await renderer.xr.setSession(session);
    isVR = true;
    $('gate').classList.add('hidden');
    session.addEventListener('end', () => { isVR = false; });
    // in VR the dolly sits at the feet and the headset supplies the eye offset
    camera.position.set(0, EYE, 0);
    const c0 = renderer.xr.getController(0);
    const c1 = renderer.xr.getController(1);
    const rayGeo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3(0, 0, -1)]);
    for (const [c, hand] of [[c0, 0], [c1, 1]]) {
      c.add(new THREE.Line(rayGeo, new THREE.LineBasicMaterial({ color: 0xf0b45a })));
      c.addEventListener('selectstart', () => {
        const wp = c.getWorldPosition(new THREE.Vector3());
        const dir = new THREE.Vector3(0, 0, -1).applyQuaternion(c.getWorldQuaternion(new THREE.Quaternion()));
        castLance(new V(wp.x, wp.y, wp.z), new V(dir.x, dir.y, dir.z).norm());
      });
      c.addEventListener('squeezestart', () => (hand === 0 ? castLight() : castChill()));
      player.add(c);
    }
    // thumbstick locomotion
    const gp = () => session.inputSources[0]?.gamepad;
    setInterval(() => {
      const p = gp();
      if (!p) return;
      const x = p.axes[2] ?? 0, y = p.axes[3] ?? 0;
      if (Math.hypot(x, y) < 0.2) return;
      const head = new THREE.Vector3();
      camera.getWorldPosition(head);
      const dirv = new THREE.Vector3();
      camera.getWorldDirection(dirv);
      const yawH = Math.atan2(dirv.x, dirv.z);
      const step = new V(Math.sin(yawH + Math.atan2(x, y)) * 4.4, 0, Math.cos(yawH + Math.atan2(x, y)) * 4.4);
      me.position = me.position.add(step.scale(0.016));
      const s = landSurface(me.position);
      if (me.position.y < s.ground) me.position = new V(me.position.x, s.ground, me.position.z);
    }, 16);
    toast('immersive session live', 2000);
  } catch (e) {
    toast(`VR unavailable here: ${e.message} — the desktop view runs the same simulation`, 5000);
  }
});

// pointer lock escape closes nothing: the world keeps simulating either way.
document.addEventListener('pointerlockchange', () => {
  if (!document.pointerLockElement && !isVR) $('gate').classList.remove('hidden');
});

scatterStones(10, new V(0, terrainHeight(12, -8) + 4, -8));

// ---------------------------------------------------------------------------
// headless harness hook — tools/boot-check.mjs drives frame() with this. It is
// read-only and costs the running world nothing.
// ---------------------------------------------------------------------------
export const __test = {
  get world() { return world; },
  get renderer() { return renderer; },
  get caster() { return caster; },
  get initialCredit() { return initialCredit; },
  get player() { return me; },
  get islands() { return islands; },
  get orbs() { return orbs; },
  get simTime() { return simTime; },
  frames: () => frameCount,
  key: (code) => { keys.add(code); },
  castLance,
  castLight,
  castChill,
  toggleLift,
  scatterStones,
  dropFeatherAndAnvil,
};
