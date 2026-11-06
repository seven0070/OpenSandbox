/**
 * universe.js — the viewer for a void you populate.
 *
 * Nothing here is authored content. The page boots an empty universe: no floor,
 * no sky, no light, no downward direction, and — because nothing is changing —
 * no elapsed time either. Every object, every surface, every photon comes from a
 * creation act, recorded in `universe.json`.
 *
 * Two rules the whole file exists to keep:
 *
 *   1. The renderer owns no physics. It reads `world.bodies`, `SPEC`, and the
 *      blackbody/thermo functions from the kernel, so a thing looks the way the
 *      laws say it must (a cooling ember reddens because Wien says so).
 *   2. You may create, not govern. There is no code path in this file that
 *      writes to a created body's velocity or temperature. The only exception is
 *      `thrust()`, on you, because ejecting reaction mass is not editing — and
 *      momentum conservation there is asserted by a test, not claimed.
 */
import * as THREE from 'three';
import {
  V,
  SI,
  SPEC,
  World,
  setSpec,
  terrainHeight,
  waterSurface,
  landSurface,
  hasGround,
  hasWater,
  setSurfaceQuery,
  blackbodyColor,
  universeState,
  totalEnergy,
  FIXED_DT,
  SEA_LEVEL,
} from './physics.js';
import {
  Genesis,
  ARCHETYPES,
  MATERIALS,
  voidSpec,
  makeSurfaceQuery,
  thrust,
  parseCommand,
  resolve,
  circularVelocity,
} from './genesis.js';

const $ = (id) => document.getElementById(id);
const errBox = $('err');
window.addEventListener('error', (e) => {
  errBox.textContent = `[universe fault] ${e.message} @${(e.filename || '').split('/').pop()}:${e.lineno || '?'}`;
});

// ---------------------------------------------------------------------------
// the universe: empty, by construction
// ---------------------------------------------------------------------------

setSpec(voidSpec());
const world = new World({ gravity: 0, dt: FIXED_DT, nBody: true });
const gen = new Genesis(world, { creatorMass: 90 });
setSurfaceQuery(makeSurfaceQuery(gen));

const renderer = new THREE.WebGLRenderer({ antialias: true, logarithmicDepthBuffer: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.xr.enabled = true;
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x000000); // not a dark sky: no sky

const camera = new THREE.PerspectiveCamera(74, innerWidth / innerHeight, 1e-3, 1e13);
const rig = new THREE.Group();
rig.add(camera);
scene.add(rig);

// The creator is a body in the universe, so created mass pulls on you and you
// can land on what you made. 90 kg of you and your suit; fuel is separate.
const you = {
  position: new V(0, 0, 0),
  velocity: new V(0, 0, 0),
  mass: 90,
  radius: 0.4,
  restitution: 0,
  heat: 0,
  fixed: false,
  kind: 'creator',
  age: 0,
  creator: true,
  fuel: 40, // kg of reaction mass: your only means of moving, and it is finite
};

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

// ---------------------------------------------------------------------------
// rendering what exists
// ---------------------------------------------------------------------------

const ambient = new THREE.AmbientLight(0x101820, 0.02);
scene.add(ambient);

const geoSphere = new THREE.IcosahedronGeometry(1, 3);
const views = new Map(); // body -> { mesh, light, trail }
let selected = 'stone';


function viewFor(b) {
  if (views.has(b)) return views.get(b);
  const mat = new THREE.MeshStandardMaterial({
    color: 0x808080,
    roughness: b.material === 'ice' ? 0.18 : b.material === 'plasma' ? 1 : 0.8,
    metalness: b.material === 'iron' ? 0.85 : 0.05,
    transparent: b.material === 'gas' || b.material === 'plasma',
    opacity: b.material === 'plasma' ? 0.95 : b.material === 'gas' ? 0.5 : 1,
    emissive: new THREE.Color(blackbodyColor(b.temperature || 0)),
    emissiveIntensity: 0,
  });
  const mesh = new THREE.Mesh(geoSphere, mat);
  mesh.castShadow = false;
  const trailPos = new Float32Array(600 * 3);
  const trailGeo = new THREE.BufferGeometry();
  trailGeo.setAttribute('position', new THREE.BufferAttribute(trailPos, 3));
  trailGeo.setDrawRange(0, 0);
  const trail = new THREE.Line(trailGeo, new THREE.LineBasicMaterial({ color: 0x557088, transparent: true, opacity: 0.55 }));
  const v = { mesh, mat, trail, trailPos, trailGeo, n: 0, light: null };
  scene.add(mesh, trail);
  views.set(b, v);
  return v;
}

function releaseView(b) {
  const v = views.get(b);
  if (!v) return;
  scene.remove(v.mesh, v.trail);
  v.mat.dispose();
  v.trailGeo.dispose();
  if (v.light) scene.remove(v.light);
  views.delete(b);
}

// terrain and sea: built from the same functions the collision solver uses,
// and they only exist if a ground was declared into existence.
let terrainMesh = null;
let seaMesh = null;

function rebuildWorldGeometry() {
  if (terrainMesh) { scene.remove(terrainMesh); terrainMesh.geometry.dispose(); terrainMesh.material.dispose(); terrainMesh = null; }
  if (seaMesh) { scene.remove(seaMesh); seaMesh.geometry.dispose(); seaMesh.material.dispose(); seaMesh = null; }
  if (!hasGround()) return;
  const span = Math.max(...SPEC.islands.map((i) => i.r * 2.6), 240);
  const seg = 200;
  const geo = new THREE.PlaneGeometry(span, span, seg, seg);
  geo.rotateX(-Math.PI / 2);
  const p = geo.attributes.position;
  const col = new Float32Array(p.count * 3);
  const c = new THREE.Color();
  for (let k = 0; k < p.count; k++) {
    const x = p.getX(k);
    const z = p.getZ(k);
    const h = terrainHeight(x, z) ?? 0;
    p.setY(k, h);
    const s = landSurface(new V(x, h, z)).normal.y;
    if (h < (SPEC.seaLevel ?? 0) + 0.5) c.setHex(0xc9b98c);
    else if (1 - s > 0.42) c.setHex(0x6b6157);
    else c.setHex(0x4f7a3a).lerp(new THREE.Color(0x2f4a24), Math.min(1, Math.max(0, (h - 4) / 14)));
    c.toArray(col, k * 3);
  }
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  geo.computeVertexNormals();
  terrainMesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95 }));
  scene.add(terrainMesh);

  if (hasWater()) {
    seaMesh = new THREE.Mesh(
      new THREE.PlaneGeometry(span * 1.4, span * 1.4, 1, 1),
      new THREE.MeshStandardMaterial({ color: 0x0b2b3a, roughness: 0.12, metalness: 0.35, transparent: true, opacity: 0.92 }),
    );
    seaMesh.rotation.x = -Math.PI / 2;
    seaMesh.position.y = SPEC.seaLevel;
    scene.add(seaMesh);
  }
}

// One sun at a time is enough to light the scene; if you create several, they all
// illuminate, from their own temperature. No invented key light.
function syncLights() {
  const hot = [...gen.bodies.values()]
    .filter((b) => (b.luminosity || 0) > 1e12)
    .sort((a, b) => b.luminosity - a.luminosity)
    .slice(0, 6);
  const want = new Set(hot.map((b) => b.id));
  for (const [b, v] of views) {
    if (want.has(b.id) && !v.light) {
      v.light = new THREE.PointLight(0xffffff, 1, 0, 2); // decay 2 = inverse square
      v.light.color = new THREE.Color(blackbodyColor(b.temperature));
      scene.add(v.light);
    } else if (!want.has(b.id) && v.light) {
      scene.remove(v.light);
      v.light = null;
    }
  }
  // One ambient light for the universe's own background temperature, created
  // once. (An earlier version added one per frame — a leak that only shows up
  // after a few thousand frames, which is exactly the kind a test should catch.)
  ambient.intensity = 0.02 + 5.67e-8 * SPEC.ambientT ** 4;
  ambient.color = new THREE.Color(blackbodyColor(SPEC.ambientT * 40));
  for (const b of hot) {
    const v = views.get(b);
    if (!v?.light) continue;
    // intensity from the body's own net luminosity, log-compressed so a 1e27 W
    // star and a 1e5 W fire are both visible without either being a lie
    v.light.intensity = Math.pow(Math.max(1, b.luminosity), 0.34) * 0.0016;
    v.light.color = new THREE.Color(blackbodyColor(b.temperature));
    v.light.distance = 0; // no cut-off: light falls off as 1/r², it does not stop
  }
}

// ---------------------------------------------------------------------------
// the view transform: one factor, applied to everything, disclosed
// ---------------------------------------------------------------------------
// A universe holding a 7e8 m star and a 4e-1 m pebble cannot be drawn in true
// scale in one depth buffer. So positions and radii are divided by a single
// scalar L chosen from the current extent. One factor for the whole scene keeps
// every *relation* honest (orbits stay circular, contact stays where it is);
// the only sin is the radius floor below, which is stated on screen.
let L = 1;

function syncScale() {
  let extent = 1;
  for (const b of world.bodies) extent = Math.max(extent, b.position.mag() + b.radius, you.position.dist(b.position) * 0.6);
  extent = Math.max(extent, you.position.mag() + 30);
  const target = extent / 260;
  L += (target - L) * 0.06; // smoothed, or the scene would pump as bodies move
  return L;
}

// ---------------------------------------------------------------------------
// you, in the void
// ---------------------------------------------------------------------------

const keys = new Set();
let yaw = 0, pitch = 0, locked = false;
const SENS = 0.0021;

renderer.domElement.addEventListener('click', () => {
  if (!locked) renderer.domElement.requestPointerLock?.();
});
document.addEventListener('pointerlockchange', () => {
  locked = !!document.pointerLockElement;
  $('gate')?.classList.add('hidden');
});
addEventListener('mousemove', (e) => {
  if (!locked) return;
  yaw -= e.movementX * SENS;
  pitch = Math.max(-1.52, Math.min(1.52, pitch - e.movementY * SENS));
});
addEventListener('keydown', (e) => {
  if ($('cmd') === document.activeElement) {
    if (e.code === 'Escape') $('cmd').blur();
    return;
  }
  keys.add(e.code);
  if (e.code === 'Backquote' || e.code === 'KeyC') { e.preventDefault(); $('cmd').focus(); }
  if (e.code === 'KeyB') createSelected();
  if (e.code === 'KeyN') { const b = nearestBody(); if (b) gen.erase(b.id); syncAll(); say(`erased ${b.name}; its ${(b.mass * SI.c ** 2).toExponential(2)} J were booked as returned`); }
  if (e.code === 'KeyT') thrustBurn(0.5);
  if (e.code === 'KeyR') { resetUniverse(); }
});
addEventListener('keyup', (e) => keys.delete(e.code));

const aimDir = () => {
  const d = camera.getWorldDirection(new THREE.Vector3());
  return new V(d.x, d.y, d.z).norm();
};

function nearestBody() {
  let best = null, bd = 1e99;
  for (const b of gen.bodies.values()) {
    const d = b.position.dist(you.position) - b.radius;
    if (d < bd) { bd = d; best = b; }
  }
  return best;
}

/** Big things need to be made far away. Spawning an Earth 4 m from you is a
 *  collision, not a creation, and gravity does not care about your intentions. */
function defaultRange(kind) {
  if (kind === 'star' || kind === 'giantStar' || kind === 'blueGiant' || kind === 'neutronStar' || kind === 'blackHole' || kind === 'whiteDwarf' || kind === 'cloud') return 4e8;
  if (kind === 'earthlike' || kind === 'superearth' || kind === 'marsworld' || kind === 'moon' || kind === 'ocean') return 4e6;
  if (kind === 'moonlet') return 4e4;
  return 40;
}

function createAt(kind, extra = {}) {
  const where = you.position.add(aimDir().scale(extra.range ?? defaultRange(kind)));
  try {
    const out = gen.create({ kind, position: where, ...extra });
    say(`+ ${out.body.name} · r ${fmtSI(out.body.radius)}m · g ${fmtSI(out.truth.surfaceGravity)}m/s² · v_esc ${fmtSI(out.truth.escapeVelocity)}m/s${out.truth.atmosphere ? ` · air ${out.truth.atmosphere.retention.verdict}` : ''}`);
    syncAll();
    return out;
  } catch (e) {
    say(`refused: ${e.message}`, true);
    return null;
  }
}

function createSelected() {
  createAt(selected, selected === 'star' || selected === 'earthlike' ? { range: 250 } : {});
}

function thrustBurn(kg) {
  const dir = aimDir();
  const r = thrust(you, dir.scale(-1), { exhaustSpeed: 3000, propellant: Math.min(kg, you.fuel), gen });
  if (!r) { you.fuel <= 0 ? say('no reaction mass left. In a void, a rocket with nothing to throw goes nowhere.') : say('burn too small to matter'); return; }
  you.fuel -= r.propellant;
  say(`burn Δv ${r.dv.toFixed(3)} m/s · fuel ${you.fuel.toFixed(2)} kg · exhaust carried ${(r.spent.velocity.mag()).toFixed(0)} m/s the other way`);
}

// ---------------------------------------------------------------------------
// motion: gravity from what you made, and nothing else
// ---------------------------------------------------------------------------

const WALK = 4.2;
function stepYou(dt) {
  // gravity of every created mass acts on you — "down" is whatever you built
  let accel = new V(0, 0, 0);
  for (const b of world.bodies) {
    if (b === you || b.mass <= 0) continue;
    const d = you.position.sub(b.position);
    const r2 = d.mag2();
    if (r2 <= 0) continue;
    accel = accel.add(d.norm().scale((-SI.G * b.mass) / r2));
  }
  if (hasGround() && SPEC.gravity > 0) accel = accel.add(new V(0, -SPEC.gravity, 0));

  // thrust / walk input, always as an exchange with reaction mass
  let wish = new V(0, 0, 0);
  const cy = Math.cos(yaw), sy = Math.sin(yaw);
  if (keys.has('KeyW')) wish = wish.add(new V(-sy, 0, -cy));
  if (keys.has('KeyS')) wish = wish.add(new V(sy, 0, cy));
  if (keys.has('KeyA')) wish = wish.add(new V(-cy, 0, sy));
  if (keys.has('KeyD')) wish = wish.add(new V(cy, 0, -sy));
  if (keys.has('Space')) wish = wish.add(new V(0, 1, 0));
  if (keys.has('ShiftLeft')) wish = wish.add(new V(0, -1, 0));

  const surf = landSurface(you.position);
  const grounded = hasGround() && Number.isFinite(surf.ground) && surf.signedDistance <= 0.05;
  if (wish.mag() > 0) {
    const dir = wish.norm();
    if (grounded) {
      // on a world you made, feet do the pushing; in the void, only mass does
      const target = dir.scale(WALK);
      you.velocity = new V(
        you.velocity.x + (target.x - you.velocity.x) * Math.min(1, 26 * dt),
        you.velocity.y + (grounded ? Math.max(0, target.y - you.velocity.y) : target.y - you.velocity.y) * Math.min(1, 26 * dt),
        you.velocity.z + (target.z - you.velocity.z) * Math.min(1, 26 * dt),
      );
    } else if (you.fuel > 0) {
      const r = thrust(you, dir, { exhaustSpeed: 3000, propellant: Math.min(0.045, you.fuel), gen });
      if (r) you.fuel -= r.propellant;
    }
  }
  you.velocity = you.velocity.add(accel.scale(dt));
  const next = you.position.add(you.velocity.scale(dt));
  const ns = landSurface(next);
  if (Number.isFinite(ns.ground) && ns.signedDistance < 0 && hasGround()) {
    const n = ns.normal;
    next.y = ns.ground;
    const vn = you.velocity.dot(n);
    if (vn < 0) you.velocity = you.velocity.sub(n.scale(vn * 1.25)); // 0.25 restitution loss → heat
  }
  // and for a created sphere, land ON it: the surface query gives us the body
  if (ns.body && ns.signedDistance < 0) {
    const outward = ns.normal;
    next.y = ns.ground;
    const vn = you.velocity.dot(outward);
    if (vn < 0) you.velocity = you.velocity.sub(outward.scale(vn * 1.2));
  }
  you.position = next;
}

// ---------------------------------------------------------------------------
// console
// ---------------------------------------------------------------------------

function say(line, bad = false) {
  const out = $('out');
  const div = document.createElement('div');
  div.textContent = line;
  if (bad) div.style.color = '#ff8f7a';
  out.prepend(div);
  while (out.children.length > 140) out.lastChild.remove();
}

function runCommand(text) {
  const line = text.trim();
  if (!line) return;
  say(`› ${line}`);
  try {
    const p = parseCommand(line);
    switch (p.op) {
      case 'help':
        say(Object.keys(ARCHETYPES).join(' · '));
        say('create <kind> [mass N] [temp N] [name s] [at x y z] [orbit <name>] | make N <kind> | spec <key> <value> | erase <id> | list | history | save | void | archipelago');
        return;
      case 'create': {
        const out = resolve(p, gen, gen.bodies, { at: you.position.add(aimDir().scale(defaultRange(p.positional[0]))) });
        say(`+ ${out.body.name}: ${out.body.mass.toExponential(2)} kg, r ${out.body.radius.toExponential(2)} m, T ${out.body.temperature.toFixed(0)} K, ${(out.truth.surfaceGravity ?? 0).toExponential(2)} m/s² at its surface${out.truth.atmosphere ? `, air ${out.truth.atmosphere.retention.verdict}` : ''}`);
        syncAll();
        return;
      }
      case 'make': {
        const n = Math.min(400, Number(p.positional[0]) || 1);
        const kind = p.positional[1] || selected;
        for (let i = 0; i < n; i++) {
          const a = Math.random() * Math.PI * 2, e = Math.acos(2 * Math.random() - 1), rr = 40 + Math.random() * 160;
          gen.create({
            kind,
            position: you.position.add(new V(Math.sin(e) * Math.cos(a) * rr, Math.cos(e) * rr * 0.5, Math.sin(e) * Math.sin(a) * rr)),
            velocity: you.velocity,
          });
        }
        if (n > 200) throw new Error(`refusing to create ${n} bodies at once; the contact solver is O(n²) and you would wait`);
        say(`+ ${n} × ${kind}`);
        syncAll();
        return;
      }
      case 'spec': {
        const k = p.positional[0];
        const v = p.args.v ?? p.positional[1];
        setSpec({ [k]: Number.isNaN(Number(v)) ? v : Number(v) });
        if (k === 'gravity') world.field.g = Number(v);
        if (k === 'ambientT') SPEC.ambientT = Number(v);
        say(`spec ${k} = ${v}`);
        rebuildWorldGeometry();
        syncAll();
        return;
      }
      case 'erase': {
        gen.erase(Number(p.positional[0]));
        syncAll();
        say('erased (booked, not deleted)');
        return;
      }
      case 'void':
        resetUniverse();
        say('the universe is empty again. every joule was returned to the ledger.');
        return;
      case 'archipelago':
        declareArchipelago();
        say('you declared ground, sea, three islands and 9.80665 m/s². stand on it.');
        return;
      case 'list':
        for (const b of gen.bodies.values()) say(`#${b.id} ${b.name} · ${(b.mass).toExponential(2)} kg · r ${b.radius.toExponential(2)} m · ${b.temperature.toFixed(0)} K`);
        if (!gen.bodies.size) say('(nothing exists)');
        return;
      case 'history':
        for (const e of gen.history().slice(-24)) say(`t=${e.t.toFixed(2)}s ${e.op} ${e.name ?? ''} ${e.mass ? e.mass.toExponential(2) + ' kg' : ''}`);
        return;
      case 'save':
        saveCharter();
        return;
      default:
        say(`I know create, make, spec, erase, list, history, save, void, archipelago, help — not '${p.op}'. Refusing to guess.`, true);
    }
  } catch (e) {
    say(e.message, true);
  }
}

$('cmd')?.addEventListener('keydown', (ev) => {
  if (ev.key === 'Enter') {
    runCommand(ev.target.value);
    ev.target.value = '';
    ev.preventDefault();
  }
});
$('go')?.addEventListener('click', () => {
  runCommand($('cmd').value);
  $('cmd').value = '';
});
document.querySelectorAll('[data-create]').forEach((el) => {
  el.addEventListener('click', () => {
    selected = el.dataset.create;
    document.querySelectorAll('[data-create]').forEach((x) => x.classList.toggle('on', x === el));
    if (selected === 'archipelago') { declareArchipelago(); say('archipelago declared: ground, sea, three islands, g = 9.80665'); return; }
    createSelected();
  });
});
$('thrust')?.addEventListener('click', () => thrustBurn(0.5));
$('reset')?.addEventListener('click', () => { resetUniverse(); say('void'); });

// ---------------------------------------------------------------------------
// the previous world, as one act of creation
// ---------------------------------------------------------------------------

function declareArchipelago() {
  setSpec({
    mode: 'archipelago',
    ground: -4.0,
    seaLevel: SEA_LEVEL,
    gravity: SI.g0,
    spin: 7.2722e-5,
    ambientT: 288.15,
    islands: [
      { x: 0, z: 0, r: 34, h: 6.0, tilt: 0 },
      { x: 92, z: -36, r: 22, h: 15.5, tilt: -0.04 },
      { x: -78, z: 70, r: 18, h: 9.5, tilt: 0.05 },
    ],
    surfaceQuery: null, // a real floor exists now; it is not "whatever I made"
  });
  world.field.g = SI.g0;
  world.waterY = SEA_LEVEL;
  rebuildWorldGeometry();
  you.position = new V(0, (terrainHeight(0, 6) ?? 0) + 0.2, 6);
  you.velocity = new V(0, 0, 0);
}

function resetUniverse() {
  // Two kinds of body live in `world`: ones genesis created (which must be
  // *returned*, booked) and incidental ones like rocket exhaust (which genesis
  // has no id for). Erasing everything through gen.erase threw on the second
  // kind, because `id` is only defined on the first.
  for (const b of [...world.bodies]) {
    if (b.id !== undefined && gen.bodies.has(b.id)) gen.erase(b.id);
    else { world.remove(b); releaseView(b); }
  }
  setSpec(voidSpec());
  setSurfaceQuery(makeSurfaceQuery(gen));
  world.field.g = 0;
  world.field.bodies = [];
  world.waterY = -1e9;
  world.time = 0;
  world.contacts = 0;
  world.ledger.entropy = 0;
  you.position = new V(0, 0, 0);
  you.velocity = new V(0, 0, 0);
  you.fuel = 40;
  you.mass = 90;
  rebuildWorldGeometry();
  syncAll();
}

// ---------------------------------------------------------------------------
// the charter file: shape it from your editor, or from a chat message
// ---------------------------------------------------------------------------

async function saveCharter() {
  const charter = {
    spec: { ...SPEC, islands: SPEC.islands, surfaceQuery: undefined },
    creator: { position: [you.position.x, you.position.y, you.position.z], fuel: you.fuel, mass: you.mass },
    created: [...gen.bodies.values()].map((b) => ({
      kind: b.kind,
      name: b.name,
      mass: b.mass,
      radius: b.radius,
      material: b.material,
      temperature: b.temperature,
      position: [b.position.x, b.position.y, b.position.z],
      velocity: [b.velocity.x, b.velocity.y, b.velocity.z],
      atmosphere: b.atmosphere ? { mass: b.atmosphere.mass, material: b.atmosphere.material } : undefined,
    })),
  };
  const res = await fetch('./universe.json', { method: 'POST', body: JSON.stringify(charter, null, 2), headers: { 'content-type': 'application/json' } })
    .catch(() => null);
  say(res && res.ok ? `saved ${charter.created.length} created things to universe.json` : 'no writable server here — the charter lives in memory only', !res?.ok);
  return charter;
}

async function loadCharter(text) {
  let c;
  try { c = JSON.parse(text); } catch { say('universe.json is not valid JSON; refusing to half-apply it', true); return; }
  resetUniverse();
  if (c.spec) {
    setSpec(c.spec);
    world.field.g = c.spec.gravity ?? 0;
    if (c.spec.seaLevel != null) world.waterY = c.spec.seaLevel;
    rebuildWorldGeometry();
    if (hasGround()) setSurfaceQuery(null);
  }
  for (const o of c.created ?? []) {
    try {
      gen.create({
        ...o,
        position: V.of({ x: o.position?.[0] ?? 0, y: o.position?.[1] ?? 0, z: o.position?.[2] ?? 0 }),
        velocity: V.of({ x: o.velocity?.[0] ?? 0, y: o.velocity?.[1] ?? 0, z: o.velocity?.[2] ?? 0 }),
      });
    } catch (e) {
      say(`skipped one entry: ${e.message}`, true);
    }
  }
  say(`loaded a universe of ${gen.bodies.size} created things${hasGround() ? ', with ground' : ', no ground'}`);
}

// Live shaping: follow universe.json. EventSource exists only in a browser, and
// this module has to import cleanly under plain `node` for the boot harness.
if (typeof EventSource !== 'undefined') {
  const watch = new EventSource('/events');
  watch.onmessage = (e) => { try { if (!e.data.includes('"empty"')) loadCharter(e.data); } catch { /* keep the current universe */ } };
  watch.addEventListener?.('charter', (e) => { try { if (!e.data.includes('"empty"')) loadCharter(e.data); } catch {} });
  watch.onerror = () => { try { watch.close(); } catch {} };
}

// ---------------------------------------------------------------------------
// HUD
// ---------------------------------------------------------------------------

const fmtSI = (x) => (Math.abs(x) >= 1e4 || (Math.abs(x) > 0 && Math.abs(x) < 1e-2) ? x.toExponential(2) : x.toFixed(Math.abs(x) > 99 ? 0 : 3));

let lastHud = 0;
function updateHud(now) {
  if (now - lastHud < 120) return;
  lastHud = now;
  const U = universeState(world);
  $('v-time').textContent = U.time.toFixed(3) + ' s';
  $('v-clock').textContent = U.evolving ? 'running' : 'no change, so no time';
  $('v-n').textContent = `${U.bodies} created`;
  $('v-mass').textContent = fmtSI(gen.massCreated) + ' kg';
  $('v-energy').textContent = fmtSI(gen.energyCreated) + ' J (mc²)';
  $('v-entropy').textContent = fmtSI(U.entropy) + ' J/K';
  $('v-heat').textContent = fmtSI(world.ledger.thermal / 1000) + ' kJ';
  $('v-light').textContent = fmtSI(world.ledger.radiated / 1000) + ' kJ';
  const v = you.velocity.mag();
  $('v-you').textContent = `${fmtSI(v)} m/s · fuel ${you.fuel.toFixed(2)} kg`;
  const g = world.bodies.reduce((acc, b) => {
    if (b === you) return acc;
    const d = you.position.sub(b.position);
    return acc + (b.mass > 0 ? (SI.G * b.mass) / Math.max(d.mag2(), 1e-6) : 0);
  }, hasGround() ? SPEC.gravity : 0);
  $('v-g').textContent = `${fmtSI(g)} m/s² of pull, all from things you made`;
  const tl = gen.history().slice(-5).reverse();
  $('v-timeline').textContent = tl.length ? tl.map((e) => `${e.op} ${e.name ?? ''}`.trim()).join(' · ') : 'nothing has happened yet';
}

// ---------------------------------------------------------------------------
// frame
// ---------------------------------------------------------------------------

let last = performance.now();
let frameCount = 0;
const loopErrors = [];

function frame() {
  frameCount++;
  const now = performance.now();
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  try {
    const steps = world.advance(dt);
    gen.evolve(dt * TIME_ACCEL);
    stepYou(dt);
    syncAll();
    updateHud(now);
    void steps;
  } catch (e) {
    loopErrors.push(e);
    if (loopErrors.length < 4) say(`frame fault: ${e.message}`, true);
  }
  renderer.render(scene, camera);
}
renderer.setAnimationLoop(frame);

// A created universe runs on geological clocks; this is the one deliberate
// affordance, and it is stated on the HUD rather than hidden.
let TIME_ACCEL = 1;
document.getElementById('accel')?.addEventListener('input', (e) => {
  TIME_ACCEL = Number(e.target.value);
  $('v-accel').textContent = `${TIME_ACCEL}×`;
});

function syncAll() {
  const scale = syncScale();
  const live = new Set(world.bodies);
  for (const b of [...views.keys()]) if (!live.has(b)) releaseView(b);
  for (const b of world.bodies) {
    if (b === you) continue;
    const v = viewFor(b);
    const r = Math.max(b.radius / scale, 0.22); // radius floor, disclosed on screen
    v.mesh.position.set(b.position.x / scale, b.position.y / scale, b.position.z / scale);
    v.mesh.scale.setScalar(r);
    const T = b.temperature || 0;
    v.mat.emissive.setHex(blackbodyColor(T));
    v.mat.emissiveIntensity = T > SPEC.ambientT + 30 ? Math.min(3.2, Math.pow(T / 2400, 2.2)) : 0;
    if (b.eventHorizon) { v.mat.emissiveIntensity = 0; v.mat.color.setHex(0x000000); }
    // orbit trails: the only way to see curvature in empty space
    if (b.mass > 1e9 || b.luminosity > 0) {
      v.trailPos[v.n * 3] = v.mesh.position.x;
      v.trailPos[v.n * 3 + 1] = v.mesh.position.y;
      v.trailPos[v.n * 3 + 2] = v.mesh.position.z;
      v.n = (v.n + 1) % (v.trailPos.length / 3);
      v.trailGeo.attributes.position.needsUpdate = true;
      v.trailGeo.setDrawRange(0, v.n);
    }
    if (v.light) v.light.position.copy(v.mesh.position);
  }
  syncLights();
  rig.position.set(you.position.x / scale, you.position.y / scale, you.position.z / scale);
  camera.rotation.order = 'YXZ';
  camera.rotation.set(pitch, yaw, 0);
  camera.near = Math.max(1e-4, scale * 1e-6);
  camera.far = Math.max(1e4, scale * 1e6);
  camera.updateProjectionMatrix();
}

// ---------------------------------------------------------------------------
// gate + XR
// ---------------------------------------------------------------------------

$('enter')?.addEventListener('click', async () => {
  $('gate')?.classList.add('hidden');
  renderer.domElement.requestPointerLock?.();
  say('a void. nothing exists, nothing changes, no time passes. create something.');
  try {
    const res = await fetch('./universe.json', { cache: 'no-store' });
    if (res.ok) { const txt = await res.text(); if (txt.trim() && txt.trim()[0] === '{') { loadCharter(txt); } }
  } catch { /* first boot: nothing has been written yet, which is the point */ }
});
$('enter-vr')?.addEventListener('click', async () => {
  try {
    if (!navigator.xr) throw new Error('no WebXR in this browser');
    if (!(await navigator.xr.isSessionSupported('immersive-vr'))) throw new Error('no immersive-vr device');
    const session = await navigator.xr.requestSession('immersive-vr', { optionalFeatures: ['local-floor', 'bounded-floor'] });
    await renderer.xr.setSession(session);
    for (const i of [0, 1]) {
      const c = renderer.xr.getController(i);
      c.addEventListener('selectstart', () => createAt(selected, { range: 3 }));
      c.addEventListener('squeezestart', () => thrustBurn(0.25));
      rig.add(c);
    }
    say('headset live. trigger creates, grip burns fuel.');
  } catch (e) { say(`VR unavailable: ${e.message}`, true); }
});

// expose for the headless boot harness
export const __test = {
  get world() { return world; },
  get gen() { return gen; },
  get you() { return you; },
  get renderer() { return renderer; },
  get SPEC() { return SPEC; },
  get L() { return L; },
  frames: () => frameCount,
  errors: () => loopErrors,
  get time() { return world.time; },
  runCommand,
  createAt,
  thrustBurn,
  declareArchipelago,
  resetUniverse,
  saveCharter,
  loadCharter,
  get views() { return views; },
};

say?.('ready');
