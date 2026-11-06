/**
 * tools/boot-check.mjs — boots src/main.js head-less and drives the world.
 *
 * There is no browser in this sandbox, so without this the render layer would
 * ship unverified. The harness runs the REAL app module against the REAL
 * three.js, replacing only WebGLRenderer (needs a GPU) and the DOM. The DOM it
 * provides is built from index.html's own id list, so `$('v-typo')` returns
 * null and throws here exactly as it would in Chrome — "the HTML and the JS
 * disagree" becomes a failing command rather than a silently blank page.
 *
 * It then runs hundreds of frames, presses every demo key, casts every spell,
 * and asserts the world stayed alive and the ledger stayed balanced.
 */
import { readFile } from 'node:fs/promises';
import { dirname, resolve, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { register } from 'node:module';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
globalThis.__bootRoot = ROOT;
register(pathToFileURL(resolve(ROOT, 'tools/boot-loader.mjs')).href, import.meta.url, {
  data: { root: ROOT },
});

// --- clock: the sim reads performance.now(), so a synchronous loop still
//     advances real seconds through the fixed-step integrator -----------------
let fakeNow = 0;
const TICK_MS = 1000 / 60;
Object.defineProperty(globalThis, 'performance', {
  configurable: true,
  value: { now: () => fakeNow, timeOrigin: 0 },
});

// --- DOM, ids lifted from the real index.html --------------------------------
const html = await readFile(resolve(ROOT, 'index.html'), 'utf8');
const ids = new Set([...html.matchAll(/id="([\w-]+)"/g)].map((m) => m[1]));

const handlers = new Map(); // type -> [fn]
const addFor = (type, fn) => {
  if (typeof fn !== 'function') return;
  if (!handlers.has(type)) handlers.set(type, []);
  handlers.get(type).push(fn);
};
globalThis.__bootOn = addFor;
globalThis.__bootNoop = () => {};
const fire = (type, ev = {}) => (handlers.get(type) || []).forEach((fn) => fn({ preventDefault() {}, ...ev }));

function mkEl(id) {
  return {
    id,
    textContent: '',
    innerHTML: '',
    style: {},
    dataset: {},
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    addEventListener: addFor,
    appendChild() {},
    insertBefore() {},
    setAttribute() {},
    getContext: () => null,
    requestPointerLock() { globalThis.__bootPointerLock = true; fire('pointerlockchange'); },
  };
}
const elById = new Map();
const seenIds = new Set();
globalThis.document = {
  getElementById(id) {
    seenIds.add(id);
    if (!ids.has(id)) return null; // and main.js will throw on it, as in a browser
    if (!elById.has(id)) elById.set(id, mkEl(id));
    return elById.get(id);
  },
  createElement: () => mkEl('created'),
  querySelector: () => null,
  addEventListener: addFor,
  removeEventListener() {},
  pointerLockElement: null,
  body: { appendChild() {}, style: {} },
};
globalThis.window = globalThis;
globalThis.devicePixelRatio = 1;
globalThis.innerWidth = 1440;
globalThis.innerHeight = 900;
globalThis.addEventListener = addFor;
globalThis.removeEventListener = () => {};
globalThis.navigator.xr = undefined;
globalThis.HTMLCanvasElement = function () {};

// --- boot -------------------------------------------------------------------
const failures = [];
const step = (label, fn) => {
  try {
    fn();
  } catch (e) {
    failures.push(`${label}: ${e?.stack?.split('\n').slice(0, 3).join(' | ') || e?.message || e}`);
  }
};

const phys = await import(pathToFileURL(resolve(ROOT, 'src/physics.js')).href);
const terrainAt = (x, z) => phys.terrainHeight(x, z);

let app;
try {
  app = await import(pathToFileURL(resolve(ROOT, 'src/main.js')).href);
} catch (e) {
  console.error(`✗ main.js failed to load:\n\n${e.stack}\n`);
  process.exit(1);
}
const T = app.__test;
if (!T) {
  console.error('✗ main.js exposes no __test hook — boot-check cannot drive it');
  process.exit(1);
}

const { world, renderer, caster } = T;
const run = (n) => {
  for (let i = 0; i < n; i++) {
    fakeNow += TICK_MS;
    step(`frame ${i}`, () => renderer.__tick());
  }
};

const before = T.frames();
run(90);

// capture the mouse the way a player would, then walk and look
step('pointer lock', () => renderer.domElement.requestPointerLock());
step('mouse look', () => {
  document.pointerLockElement = renderer.domElement;
  fire('pointerlockchange');
  for (let i = 0; i < 20; i++) fire('mousemove', { movementX: 6 - i * 0.3, movementY: 1.5 });
});

const keys = ['KeyW', 'KeyA', 'KeyD', 'KeyS', 'Space'];
keys.forEach((code) => step(`hold ${code}`, () => { fire('keydown', { code }); run(12); fire('keyup', { code }); }));

// every demo key in the HUD legend, then keep simulating while they play out
for (const code of ['KeyP', 'KeyT', 'KeyF', 'KeyG', 'KeyH', 'KeyH']) {
  step(`press ${code}`, () => { fire('keydown', { code }); run(24); });
}
run(180); // let the scattered stones hit the ground and come to rest
const midContacts = world.contacts;
const resting = world.bodies.filter((b) => b.kind === 'stone' && b.velocity.mag() < 0.6);
step('click to cast', () => { fire('click', { button: 0 }); run(24); });
run(300);
step('reset', () => { fire('keydown', { code: 'KeyR' }); run(30); });

// resize, blur, and a long stall (tab switch) must not explode or teleport
step('resize', () => { globalThis.innerWidth = 900; globalThis.innerHeight = 1600; fire('resize'); run(5); });
step('long stall', () => { fakeNow += 9000; renderer.__tick(); });

const moved = world.bodies.some((b) => Number.isFinite(b.position.x) && Number.isFinite(b.position.y));
const sunkCount = world.bodies.filter((b) => {
  const h = terrainAt(b.position.x, b.position.z);
  return b.position.y < h - b.radius * 0.5;
}).length;
const finite = world.bodies.every((b) =>
  [b.position.x, b.position.y, b.position.z, b.velocity.x, b.velocity.y, b.velocity.z].every(Number.isFinite),
);
const playerSane = Number.isFinite(T.player.position.y) && T.player.position.y > -70;
const audit = caster.ledger.audit(T.initialCredit);
const islandAlive = T.islands.every((i) => i.store.remainingFraction >= 0);

const report = {
  framesRun: T.frames() - before,
  contactsMidRun: midContacts,
  stonesAtRest: resting.length,
  simSeconds: Number(world.time.toFixed(2)),
  physicsSteps: Math.round(world.time / world.dt),
  bodies: world.bodies.length,
  contacts: world.contacts,
  playerAltitude: Number(T.player.position.y.toFixed(2)),
  chargeLeftkJ: Number((caster.ledger.stored / 1000).toFixed(1)),
  ledgerDriftJ: Number(audit.drift.toExponential(2)),
  hudIdsRequested: seenIds.size,
  hudIdsMissing: [...seenIds].filter((id) => !ids.has(id)),
  islandChargeFloor: Number(Math.min(...T.islands.map((i) => i.store.remainingFraction)).toFixed(4)),
};
console.log(JSON.stringify(report, null, 2));

const checks = [
  ['an animation loop was registered', typeof renderer.__cb === 'function'],
  ['hundreds of frames ran', report.framesRun > 300],
  ['no NaN in any body', finite && moved],
  ['the player has a sane altitude', playerSane],
  ['the ledger still balances after a full play session', audit.ok],
  ['no HUD element was requested with a missing id', report.hudIdsMissing.length === 0],
  ['every island store is non-negative', islandAlive],
  ['no frame threw', failures.length === 0],
  ['stones really collided with the world', midContacts > 0],
  ['and they came to rest instead of jittering forever', resting.length > 0],
  ['nothing sank through the terrain', sunkCount === 0],
];
console.log('');
let bad = 0;
for (const [label, ok] of checks) {
  console.log(`  ${ok ? '✓' : '✗'} ${label}`);
  if (!ok) bad++;
}
if (failures.length) {
  console.log('\nfirst faults:');
  for (const f of failures.slice(0, 5)) console.log('  · ' + f);
}
if (bad) {
  console.log(`\n✗ boot check failed (${bad} of ${checks.length} checks)`);
  process.exit(1);
}
console.log(`\n✓ all ${checks.length} boot checks pass — the world loads, runs ${report.simSeconds} s of sim, and keeps its laws`);
process.exit(0);
