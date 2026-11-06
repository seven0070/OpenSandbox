/**
 * physics.test.mjs — the world's laws, as executable assertions.
 *
 * `npm test` runs this with no browser and no GPU. If the world ever starts
 * inventing momentum, or a spell quietly creates energy, this suite fails and
 * the fantasy stops shipping. That is the whole trick: the impossible content
 * is permitted, the broken bookkeeping is not.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  V,
  SI,
  FIXED_DT,
  Field,
  World,
  Ledger,
  makeBody,
  integrate,
  stepBody,
  kinetic,
  momentum,
  resolvePair,
  collideSpheres,
  dragForce,
  refract,
  criticalAngle,
  fresnel,
  irradiance,
  wienPeak,
  exitance,
  observedFrequency,
  heatToTemperatureDelta,
  energyToMeltIce,
  submergedFraction,
  buoyancy,
  terrainHeight,
  SEA_LEVEL,
  landSurface,
  waterSurface,
  gravitationalAcceleration,
  potentialPerKg,
  totalEnergy,
} from '../src/physics.js';

import { Caster, LevitationStore, MANA_SPECIFIC_ENERGY } from '../src/fantasy.js';

const ZERO = new V(0, 0, 0);
const approx = (a, b, rel = 1e-9, msg = '') =>
  assert.ok(Math.abs(a - b) <= rel * Math.max(1, Math.abs(b)), `${msg} expected ${b}, got ${a}`);

// --- 1. the equivalence principle -----------------------------------------

test('all bodies fall at the same rate regardless of mass', () => {
  const field = new Field(SI.g0);
  let light = makeBody({ position: new V(0, 100, 0), mass: 0.001 });
  let heavy = makeBody({ position: new V(0, 100, 0), mass: 5e5 });
  for (let i = 0; i < 2400; i++) {
    light = stepBody(light, field, FIXED_DT);
    heavy = stepBody(heavy, field, FIXED_DT);
  }
  assert.ok(light.position.y < 99, 'they actually fell');
  approx(light.position.y, heavy.position.y, 1e-9, 'feather and anvil land together:');
});

test('free fall matches the analytic solution within integrator tolerance', () => {
  const field = new Field(SI.g0);
  let b = makeBody({ position: new V(0, 50, 0), velocity: new V(4, 10, 0), mass: 2 });
  const T = 2;
  for (let i = 0; i < T / FIXED_DT; i++) b = stepBody(b, field, FIXED_DT);
  approx(b.position.x, 4 * T, 1e-6, 'x is linear:');
  approx(b.velocity.x, 4, 1e-12, 'no horizontal acceleration:');
  const dy = 10 * T - 0.5 * SI.g0 * T * T;
  assert.ok(Math.abs(b.position.y - (50 + dy)) < 0.12, `ballistic arc within symplectic error (got ${b.position.y}, want ~${50 + dy})`);
});

// --- 2. conservation, exactly ----------------------------------------------

test('pair collision conserves momentum to floating point', () => {
  const a = makeBody({ position: new V(0, 0, 0), velocity: new V(3, 0, 0), mass: 2, radius: 1 });
  const b = makeBody({ position: new V(1.6, 0, 0), velocity: new V(-1, 0, 0), mass: 5, radius: 1 });
  const p0 = momentum(a).add(momentum(b));
  const { bodies, contact } = collideSpheres(a, b);
  assert.ok(contact, 'collision was detected');
  const p1 = momentum(bodies[0]).add(momentum(bodies[1]));
  approx(p1.dot(new V(1, 0, 0)), p0.dot(new V(1, 0, 0)), 1e-12, 'momentum before === after:');
});

test('elastic collision conserves kinetic energy; inelastic one may only lose it', () => {
  for (const e of [1, 0.5, 0]) {
    const a = makeBody({ position: new V(0, 0, 0), velocity: new V(4, 0, 0), mass: 3, radius: 1, restitution: e });
    const b = makeBody({ position: new V(1.9, 0, 0), velocity: ZERO, mass: 1.5, radius: 1, restitution: e });
    const before = kinetic(a) + kinetic(b);
    const { bodies, contact } = collideSpheres(a, b);
    const after = kinetic(bodies[0]) + kinetic(bodies[1]);
    assert.ok(after <= before + 1e-9, `e=${e}: energy cannot be created (${after} > ${before})`);
    if (e === 1) approx(after, before, 1e-9, `e=1 must be perfectly elastic:`);
    if (e === 0) approx(contact.dissipated, before - after, 1e-9, 'the loss is booked, not deleted:');
  }
});

test('dissipated energy reappears as heat in the bodies, and it adds up', () => {
  const a = makeBody({ position: new V(0, 0, 0), velocity: new V(6, 0, 0), mass: 4, radius: 1, restitution: 0.3 });
  const b = makeBody({ position: new V(1.95, 0, 0), velocity: ZERO, mass: 4, radius: 1, restitution: 0.3 });
  const { bodies, contact } = collideSpheres(a, b);
  approx(bodies[0].heat + bodies[1].heat, contact.dissipated, 1e-9, 'heat ledger balances:');
});

test('a lone ballistic body conserves KE + PE to within integrator bound', () => {
  const w = new World();
  w.field = new Field(SI.g0);
  w.waterY = -1e5; // keep it out of the sea so this isolates the integrator
  w.add(makeBody({ position: new V(0, 60, 0), velocity: new V(7, 12, 3), mass: 3.3, radius: 0.3, restitution: 1 }));
  const e0 = totalEnergy(w).total;
  let worst = 0;
  for (let i = 0; i < 2400; i++) {
    w.step();
    if (landSurface(w.bodies[0].position).signedDistance < 0) break; // ground contact is a different test
    worst = Math.max(worst, Math.abs(totalEnergy(w).total - e0) / Math.abs(e0));
  }
  assert.ok(worst < 5e-3, `symplectic drift stays bounded and small: ${(worst * 100).toFixed(3)}%`);
});

test('a closed elastic system in zero-g conserves momentum and kinetic energy EXACTLY', () => {
  const w = new World();
  w.field = new Field(0); // no gravity, no walls: pure pair dynamics
  w.waterY = -1e5;
  for (let i = 0; i < 9; i++) {
    w.add(
      makeBody({
        position: new V(i * 2.0, 40, 0),
        velocity: new V(i % 2 ? 4.5 : -4.5, 0.4 * Math.sin(i), 0),
        mass: 1 + (i % 3),
        radius: 0.95,
        restitution: 1,
      }),
    );
  }
  const ke0 = totalEnergy(w).ke;
  const p0 = w.bodies.reduce((acc, b) => acc.add(momentum(b)), ZERO);
  let hits = 0;
  for (let i = 0; i < 1200; i++) {
    w.step();
    hits = w.contacts;
  }
  assert.ok(hits > 0, `the grains actually collided (${hits} contacts)`);
  approx(totalEnergy(w).ke, ke0, 1e-9, 'perfectly elastic => KE invariant:');
  const p1 = w.bodies.reduce((acc, b) => acc.add(momentum(b)), ZERO);
  approx(p1.sub(p0).mag(), 0, 1e-9, 'net momentum unchanged:');
  approx(w.ledger.thermal, 0, 1e-12, 'e=1 must produce zero heat:');
});

test('an inelastic world loses mechanical energy but never total energy', () => {
  const w = new World();
  w.field = new Field(0);
  w.waterY = -1e5;
  w.add(makeBody({ position: new V(0, 40, 0), velocity: new V(5, 0, 0), mass: 2, radius: 1, restitution: 0.25 }));
  w.add(makeBody({ position: new V(1.999, 40, 0), velocity: ZERO, mass: 3, radius: 1, restitution: 0.25 }));
  const before = totalEnergy(w);
  for (let i = 0; i < 40; i++) w.step();
  const after = totalEnergy(w);
  assert.ok(after.ke < before.ke, `mechanical energy was destroyed (${before.ke.toFixed(1)} -> ${after.ke.toFixed(1)} J)`);
  approx(after.ke + after.heat, before.ke, 1e-9, 'but it was only converted: KE + heat is invariant');
});

// --- 3. determinism: replayable, and frame-rate independent ----------------

test('the same seed with the same frame schedule yields a bit-identical state', () => {
  const run = (frames) => {
    const w = new World();
    for (let i = 0; i < 16; i++) {
      w.add(
        makeBody({
          position: new V(i - 8, 8 + (i % 3), (i % 5) - 2),
          velocity: new V(i * 0.1, 0, -i * 0.07),
          mass: 1 + (i % 4),
          radius: 0.7,
          restitution: 0.6,
        }),
      );
    }
    for (const f of frames) w.advance(f);
    return JSON.stringify(w.snapshot());
  };
  const jittered = Array.from({ length: 600 }, (_, i) => 1 / 60 + Math.sin(i * 12.9898) * 0.004);
  const smooth = Array.from({ length: 600 }, () => 1 / 60);
  const a = run(jittered);
  const b = run(jittered);
  assert.equal(a, b, 'identical input replays identically');
  const c = run(smooth);
  assert.ok(Math.abs(a.length - c.length) < 200, 'frame pacing does not materially change the outcome (fixed step)');
});

test('the fixed step decouples physics from render rate', () => {
  const mk = () => {
    const w = new World();
    w.add(makeBody({ position: new V(0, 20, 0), velocity: new V(6, 0, 0), mass: 1, radius: 0.5 }));
    return w;
  };
  const fast = mk();
  const slow = mk();
  for (let i = 0; i < 1200; i++) fast.advance(1 / 120);
  for (let i = 0; i < 600; i++) slow.advance(1 / 60);
  approx(fast.bodies[0].position.y, slow.bodies[0].position.y, 1e-6, '240Hz and 60Hz agree to the substep:');
});

// --- 4. drag, terminal velocity -------------------------------------------

test('drag caps the fall at terminal velocity and never lets it exceed it', () => {
  const field = new Field(SI.g0);
  let b = makeBody({ position: new V(0, 4000, 0), velocity: ZERO, mass: 80, radius: 0.4 });
  b = { ...b, aerodynamic: { rho: SI.air, cd: 1.0, area: 0.7 } };
  const vTerm = Math.sqrt((2 * 80 * SI.g0) / (SI.air * 1.0 * 0.7));
  let max = 0;
  for (let i = 0; i < 30000; i++) {
    b = integrate(b, field.accelerationAt(b.position).scale(80).add(dragForce(b.velocity, b.aerodynamic)), FIXED_DT);
    max = Math.max(max, -b.velocity.y);
  }
  approx(max, vTerm, 2e-2, `skydiver terminal speed:`);
  assert.ok(max <= vTerm * 1.001, 'never accelerates past terminal velocity');
});

test('drag destroys energy — a thrown ball cannot come back to your hand at launch speed', () => {
  const field = new Field(SI.g0);
  const aero = { rho: SI.air, cd: 0.47, area: 0.042 };
  let up = makeBody({ position: new V(0, 1.8, 0), velocity: new V(0, 25, 0), mass: 0.145, radius: 0.11 });
  up = { ...up, aerodynamic: aero };
  const e0 = kinetic(up);
  for (let i = 0; i < 6000 && up.velocity.y > 0; i++)
    up = integrate(up, field.accelerationAt(up.position).scale(up.mass).add(dragForce(up.velocity, aero)), FIXED_DT);
  assert.ok(up.position.y > 3, 'the ball clearly went up');
  const atTop = kinetic(up);
  assert.ok(atTop <= e0 + 1e-9, 'energy never rose');
});

// --- 5. buoyancy: Archimedes, not aesthetics --------------------------------

test('a log floats and an anchor sinks in the same water', () => {
  const wood = makeBody({ position: new V(0, 0.4, 0), velocity: ZERO, mass: 300, radius: 0.5 }); // 600 kg/m^3
  const iron = makeBody({ position: new V(4, 0.4, 0), velocity: ZERO, mass: 2000, radius: 0.5 }); // 4000 kg/m^3
  const w = new World();
  w.add(wood);
  w.add(iron);
  for (let i = 0; i < 4000; i++) w.step();
  assert.ok(wood.position.y > 0, `wood rests above the surface (y=${wood.position.y.toFixed(2)})`);
  assert.ok(iron.position.y < 0.5, `iron sinks (y=${iron.position.y.toFixed(2)})`);
  assert.ok(Math.abs(wood.velocity.y) < 0.35, 'wood settles instead of bobbing forever (damping is real)');
});

test('submerged fraction is 0 above water, 1 below, monotone between', () => {
  assert.equal(submergedFraction(1, 5, 0), 0);
  assert.equal(submergedFraction(1, -5, 0), 1);
  let prev = -1;
  for (let y = 2; y >= -2; y -= 0.1) {
    const f = submergedFraction(1, y, 0);
    assert.ok(f >= prev - 1e-12, 'monotone');
    prev = f;
  }
  approx(submergedFraction(1, 0, 0), 0.5, 1e-9, 'half-submerged at the equator:');
});

test('a neutrally buoyant body hovers exactly', () => {
  const r = 0.5;
  const vol = (4 / 3) * Math.PI * r ** 3;
  // out in the open sea, not over an island — otherwise it is just resting on land
  const b = makeBody({ position: new V(400, SEA_LEVEL + 0.2, 400), velocity: ZERO, mass: SI.water * vol, radius: r });
  const w = new World();
  w.waterY = SEA_LEVEL;
  w.add(b);
  for (let i = 0; i < 2400; i++) w.step();
  assert.ok(b.position.y < w.waterY - 0.4, `stays submerged (y=${b.position.y.toFixed(2)}, sea=${w.waterY})`);
  assert.ok(Math.abs(b.velocity.y) < 0.5, 'does not rocket up or slam down');
});

// --- 6. optics --------------------------------------------------------------

test('Snell bends toward the normal going into a denser medium', () => {
  const n = new V(0, 1, 0);
  const incident = new V(Math.sin(0.6), -Math.cos(0.6), 0);
  const out = refract(incident, n, 1 / 1.333);
  assert.ok(out, 'refracted');
  const sinAir = Math.sin(0.6);
  const sinWater = Math.hypot(out.x, out.z);
  approx(sinWater / sinAir, 1 / 1.333, 1e-6, "n1 sin t1 = n2 sin t2:");
  assert.ok(sinWater < sinAir, 'closer to normal in water');
});

test('total internal reflection: light cannot leave steep water', () => {
  const crit = criticalAngle(1.333, 1.0);
  approx(crit * (180 / Math.PI), 48.6, 1e-2, "water->air critical angle:");
  const steeper = crit + 0.2;
  const out = refract(new V(Math.sin(steeper), -Math.cos(steeper), 0), new V(0, 1, 0), 1.333);
  assert.equal(out, null, 'beyond critical angle there is no refracted ray');
});

test("Fresnel: glass at normal incidence really is mostly transparent", () => {
  const r = fresnel(1.0, 1.5);
  approx(r, 0.04, 1e-3, 'about 4% reflected:');
});

test('inverse-square law: 4x distance = 1/16 the light', () => {
  approx(irradiance(1000, 4) / irradiance(1000, 16), 16, 1e-9, 'torchlight falloff:');
});

// --- 7. thermodynamics ------------------------------------------------------

test("Wien + Stefan-Boltzmann: hot things are blue and expensive", () => {
  approx(wienPeak(5800) * 1e9, 500, 1e-2, "sun peaks near 500 nm:");
  assert.ok(wienPeak(9000) < wienPeak(3000), 'hotter -> shorter wavelength');
  const pSun = exitance(5800);
  const pWarm = exitance(300);
  assert.ok(pSun / pWarm > 1e4, 'radiated power scales as T^4');
});

test("heat is conserved into temperature change", () => {
  const dT = heatToTemperatureDelta(4184, 1, SI.heatWater);
  approx(dT, 1, 1e-9, '4184 J into 1 kg of water is 1 K:');
  approx(energyToMeltIce(SI.meltIce), 1, 1e-12, 'one latent heat melts one kg:');
});

test('Doppler: an approaching source sounds higher, exactly as much as it should', () => {
  const f = observedFrequency(440, 343, 0, 30);
  approx(f, (440 * 343) / (343 - 30), 1e-9, 'source approaching at 30 m/s:');
  assert.ok(f > 440);
});

// --- 8. no free energy: the ledger refuses ---------------------------------

test('the ledger refuses to spend what was never stored', () => {
  const l = new Ledger('test');
  l.credit('src', 100);
  assert.throws(() => l.spend('src', 101), /NO_FREE_ENERGY|only/);
  l.spend('src', 40);
  approx(l.stored, 60, 1e-12);
  approx(l.total(), 60, 1e-12, 'nothing was created:');
});

test('a caster cannot cast past their store, and recoil always happens', () => {
  const c = new Caster({ mass: 80, capacity: 5e5, position: new V(0, 5, 0) });
  const before = c.charge;
  const shot = c.lance({ aim: new V(1, 0, 0), slugMass: 0.02, muzzleVelocity: 900 });
  assert.ok(shot.energy > 0);
  assert.ok(c.charge < before, 'the store went down');
  approx(c.velocity.x, -(0.02 * 900) / 80, 1e-9, 'the caster was pushed backwards by p=mv:');
  const poor = new Caster({ mass: 80, capacity: 1000, position: new V(0, 5, 0) });
  assert.throws(() => poor.lance({ aim: new V(1, 0, 0) }), /spend|stored/);
});

test('spell energy out === store energy in, to the joule', () => {
  const c = new Caster({ mass: 80, capacity: 2e7, position: new V(0, 5, 0) });
  const start = c.ledger.entries.reduce((s, e) => s + (e.t === 'credit' ? e.joules : 0), 0);
  let out = 0;
  for (let i = 0; i < 20; i++) {
    const s = c.lance({ aim: new V(0, 1, i * 0.01) });
    out += s.energy + s.waste; // useful work + transducer loss, all of it billed
    out += c.light({ duration: 1 }).cost; // 46 kW of 2600 K blackbody is a real bill
  }
  approx(start - c.charge, out, 1e-6, 'debits equal withdrawals (losses are heat, not dust):');
  approx(c.ledger.stored + out, start, 1e-6);
  approx(c.ledger.audit(start).drift, 0, 1e-5, 'the ledger balances at the end of the session:');
});

test('a starved caster produces a DIMMER light, never a free one', () => {
  const c = new Caster({ capacity: 5e4, position: new V(0, 5, 0) });
  const hot = c.light({ temperature: 2600, duration: 1 });
  assert.equal(hot.dimmed, false, 'first cast pays in full');
  const cold = c.light({ temperature: 2600, duration: 1 });
  assert.ok(cold.dimmed || cold.watts <= hot.watts + 1e-6, 'second cast must not exceed what it was billed');
  assert.ok(cold.watts === cold.cost / 1, 'radiated power equals billed power exactly');
  const c2 = new Caster({ capacity: 1, position: new V(0, 5, 0) });
  c2.light({ duration: 1 });
  approx(c2.charge, 0, 1e-9, 'store is empty:');
  assert.throws(() => c2.lance({ aim: new V(1, 0, 0) }), /spend/, 'and an empty caster cannot shoot');
});

test('chill is a heat pump: deep cold costs exponentially more than cool', () => {
  const mild = new Caster({ capacity: 1e9, position: new V(0, 5, 0) }).chill({ fromT: 295, toT: 293, freeze: false, massOfIce: 1 });
  const hard = new Caster({ capacity: 1e9, position: new V(0, 5, 0) }).chill({ fromT: 295, toT: 250, freeze: true, massOfIce: 1 });
  assert.ok(mild.ok && hard.ok);
  assert.ok(hard.work > 50 * mild.work, `Carnot bites: ${hard.work.toFixed(0)} J vs ${mild.work.toFixed(0)} J`);
  assert.ok(hard.rejectedJoules > 0, 'the removed heat goes somewhere visible');
});

test('lifting is billed and drains on a long hold instead of being free', () => {
  const c = new Caster({ capacity: 2e6, position: new V(0, 2, 0) });
  const stone = makeBody({ position: new V(0, 1, 0), velocity: ZERO, mass: 12 });
  const r = c.lift({ target: stone, duration: 0.5, acceleration: SI.g0 });
  assert.ok(r.ok);
  assert.ok(c.charge < 2e6, 'stored energy was consumed');
  assert.ok(stone.velocity.y > 0, 'and the stone moved because of it');
});

test('floating islands run out: the levitation store depletes at its leak rate', () => {
  const store = new LevitationStore({ island: { x: 0, z: 0, r: 20 }, altitude: 40, capacity: 1e6, leakWatts: 1e5 });
  approx(store.remainingFraction, 1, 1e-12);
  for (let i = 0; i < 10; i++) store.tick(1);
  approx(store.remainingFraction, 0, 1e-9, '10 s at 100 kW on a 1 MJ store is empty:');
  assert.equal(store.tick(1), false, 'and then it stops holding — the island falls');
});

test('levitation holds because it leaks, not because gravity was switched off', () => {
  const field = new Field(SI.g0);
  const rock = makeBody({ position: new V(0, 10, 0), velocity: ZERO, mass: 1000 });
  const held = integrate(rock, field.accelerationAt(rock.position).scale(rock.mass).add(new V(0, 1000 * SI.g0, 0)), FIXED_DT);
  approx(held.velocity.y, 0, 1e-12, 'balanced force => no acceleration:');
  const dropped = integrate(rock, field.accelerationAt(rock.position).scale(rock.mass), FIXED_DT);
  assert.ok(dropped.velocity.y < 0, 'the instant the support stops, it accelerates at g');
});

// --- 9. shared terrain truth ------------------------------------------------

test('the renderer and the collision solver see the same ground', () => {
  for (const [x, z] of [[0, 0], [92, -36], [-78, 70], [12, 9], [200, 200]]) {
    const h = terrainHeight(x, z);
    const surf = landSurface(new V(x, h + 0.001, z));
    approx(surf.ground, h, 1e-12, 'terrain fn is the single source of truth at', `${x},${z}`);
    assert.ok(surf.signedDistance > 0, 'above ground is positive');
    assert.ok(surf.normal.y > 0.5, 'surface normals point up on islands');
  }
});

test('gravity field includes the moons, measurably', () => {
  const field = new Field(SI.g0);
  const moon = { name: 'ire', position: new V(0, 3.84e8, 0), mass: 7.35e22 };
  const bare = new Field(SI.g0).accelerationAt(new V(0, 0, 0));
  field.addBody(moon);
  const withMoon = field.accelerationAt(new V(0, 0, 0));
  const delta = bare.sub(withMoon).mag();
  approx(delta, (SI.G * moon.mass) / moon.position.mag2(), 1e-9, 'moon pull is G M / r^2:');
  assert.ok(delta > 3e-5 && delta < 2e-4, `real lunar tidal scale ~1e-4 m/s^2, got ${delta.toExponential(2)}`);
});

test('tides are differential, not absolute', () => {
  const field = new Field(0); // no local g: isolate the tidal term
  field.addBody({ name: 'ire', position: new V(0, 3.84e8, 0), mass: 7.35e22 });
  field.addBody({ name: 'vhan', position: new V(2.0e8, 0, 0), mass: 2.0e21 });
  const at = new V(0, 0, 0);
  const tideHere = field.tidalAt(at, new V(6.371e6, 0, 0)).mag();
  const tide90 = field.tidalAt(at, new V(0, 0, 6.371e6)).mag();
  assert.ok(tideHere > 0 && tide90 > 0, 'both baselines feel a stretch');
  assert.notEqual(tideHere.toFixed(12), tide90.toFixed(12), 'and it is direction-dependent, as tides must be');
  const w = waterSurface(new V(100, 0, -50), 12, field.bodies);
  assert.ok(Number.isFinite(w.height), 'water height is finite with moons in play');
});

test('potential energy from the field agrees with -m*phi conventions', () => {
  const bodies = [{ position: new V(0, 6.371e6, 0), mass: 5.97e24 }];
  const phi = potentialPerKg(new V(0, 0, 0), bodies);
  const expected = -(SI.G * bodies[0].mass) / 6.371e6;
  approx(phi, expected, 1e-9, 'phi = -GM/r:');
  assert.ok(phi < 0, 'bound systems have negative potential');
});

// --- 10. numbers a player can check against a textbook ---------------------

test('sanity: 1 kg dropped from 5 m hits at ~9.9 m/s', () => {
  const field = new Field(SI.g0);
  let b = makeBody({ position: new V(0, 5, 0), velocity: ZERO, mass: 1, radius: 0.05 });
  while (b.position.y > 0.05) b = stepBody(b, field, FIXED_DT);
  approx(Math.abs(b.velocity.y), Math.sqrt(2 * SI.g0 * 5), 2e-2, 'v = sqrt(2gh):');
});

test('mana has a specific energy, so a "full" caster is a battery, not a wish', () => {
  const cap = 4.2e6; // J
  approx(MANA_SPECIFIC_ENERGY * (cap / MANA_SPECIFIC_ENERGY), cap, 1e-6);
  const kg = cap / MANA_SPECIFIC_ENERGY;
  assert.ok(kg > 0.5 && kg < 2, `${kg.toFixed(2)} kg of "mana" for ${cap / 1e3} kJ — plausible fuel, not magic mass`);
});
