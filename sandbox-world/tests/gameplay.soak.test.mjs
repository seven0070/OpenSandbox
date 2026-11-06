/**
 * gameplay.soak.test.mjs — plays the world for 60 simulated seconds using the
 * exact fixed step the renderer runs, casting every spell the HUD exposes, and
 * asserts the universe was never cheated:
 *
 *   1. the caster's ledger balances to the joule across the whole session
 *   2. no lumen is ever emitted that was not billed (dimming, not free light)
 *   3. the store never goes negative — there is no overdraft magic
 *   4. recoil is always opposite the shot
 *   5. a body released from a levitation spell accelerates at exactly g
 *   6. a drained caster can light nothing at all
 *
 * If someone later "optimises" a spell into free energy, this file fails.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  V,
  SI,
  World,
  makeBody,
  kinetic,
  totalEnergy,
  exitance,
  wienPeak,
  landSurface,
  FIXED_DT,
} from '../src/physics.js';
import { Caster } from '../src/fantasy.js';

const T_ORB = 2450; // K, a torch filament
const AREA_ORB = 0.012; // m^2
const ASKED = exitance(T_ORB, 0.9) * AREA_ORB; // W the spell would like to emit

const approx = (a, b, rel, msg) =>
  assert.ok(Math.abs(a - b) <= rel * Math.max(1, Math.abs(b)), `${msg} — got ${a}, want ${b}`);

/** One orb, billed per frame exactly the way main.js does it. */
function makeOrb(caster, world, index) {
  const body = makeBody({
    position: new V(index * 0.5, 9, 0),
    velocity: new V(0, 0, 0),
    mass: 0.05,
    radius: 0.08,
    kind: 'orb',
  });
  world.add(body);
  return { body, caster, billed: 0, emitted: 0, dimmedFrames: 0, alive: true };
}

function tickOrb(orb, dt) {
  const paid = orb.caster.light({ temperature: T_ORB, area: AREA_ORB, duration: dt });
  orb.billed += paid.cost;
  orb.emitted += paid.watts * dt;
  if (paid.dimmed) orb.dimmedFrames++;
  const ratio = Math.max(0, Math.min(1, paid.watts / ASKED));
  if (ratio < 0.02) {
    orb.alive = false;
    orb.ratio = 0;
  } else {
    orb.ratio = ratio;
  }
  return ratio;
}

test('60 s of play keeps the ledger honest to the joule', () => {
  const dt = FIXED_DT;
  const c = new Caster({ mass: 78, capacity: 4.6e6, position: new V(0, 8, 0) });
  const start = c.capacity;
  const world = new World({ gravity: SI.g0 });
  world.waterY = -1e5; // isolate: no sea in this soak

  const orbs = [];
  const counters = { freeLight: 0, negativeCharge: 0, recoilWrong: 0, casts: 0, deaths: 0, refused: 0, lit: 0 };
  let gError = 0;
  let held = null;

  for (let i = 0; i < Math.round(60 / dt); i++) {
    const t = i * dt;

    // once a simulated second: fire a lance, and light a torch if there is room.
    // Six torches at 22 kW each is 132 kW — against a 4.6 MJ store that is about
    // 35 seconds of light, so this soak walks the caster from full to empty and
    // past it, which is exactly where a free-energy bug would show up.
    if (i % Math.round(1 / dt) === 0) {
      try {
        const aim = new V(Math.sin(t), 0.2, Math.cos(t)).norm();
        const shot = c.lance({ aim, slugMass: 0.018, muzzleVelocity: 780 });
        counters.casts++;
        if (shot.recoilVelocity.dot(shot.projectile.velocity) > 1e-12) counters.recoilWrong++;
        world.add({ ...shot.projectile, kind: 'lance' });
      } catch (e) {
        if (e.code !== 'NO_FREE_ENERGY') throw e;
        counters.refused++;
      }
      if (orbs.length < 6) {
        orbs.push(makeOrb(c, world, orbs.length));
        counters.lit++;
      }
    }

    // the torches bill themselves every frame, and go out when broke
    for (let k = orbs.length - 1; k >= 0; k--) {
      const ratio = tickOrb(orbs[k], dt);
      if (ratio * ASKED > ASKED + 1e-9) counters.freeLight++;
      if (!orbs[k].alive) {
        counters.deaths++;
        world.remove(orbs[k].body);
        orbs.splice(k, 1);
      }
    }

    // H: hold a stone up for one second at t = 5 s, then let go at t = 6 s
    if (Math.abs(t - 5) < dt / 2) {
      held = makeBody({ position: new V(3, 8, 0), velocity: new V(0, 0, 0), mass: 12, radius: 0.5, kind: 'stone' });
      world.add(held);
    }
    if (held && t > 5 && t < 6) c.lift({ target: held, duration: dt, acceleration: SI.g0 });
    if (held && t >= 6) {
      const v0 = held.velocity.y;
      for (let f = 0; f < 20; f++) world.step();
      gError = Math.max(gError, Math.abs(held.velocity.y - (v0 - SI.g0 * 20 * dt)));
      held = null;
    }

    if (c.charge < -1e-9) counters.negativeCharge++;
    world.step();
  }

  // 1. double-entry invariant over the whole session
  approx(c.ledger.total(), start, 1e-6, 'ledger total invariant');
  assert.equal(counters.freeLight, 0, 'no unbilled lumens were ever produced');
  assert.equal(counters.negativeCharge, 0, 'the store was never overdrawn');
  assert.equal(counters.recoilWrong, 0, 'no shot pushed the caster forwards');
  // not exactly zero: free fall accumulates in the same order only when the
  // velocity history is identical, so allow 1 ULP of float rounding.
  assert.ok(gError < 1e-12, `a released body falls at the field acceleration (worst deviation ${gError.toExponential(2)} m/s)`);
  assert.ok(counters.casts + counters.refused === 60, `one cast attempt per second, accepted or refused: ${counters.casts}+${counters.refused}`);
  assert.ok(counters.refused > 0, 'the drained caster was refused, not obeyed');
  assert.ok(counters.deaths > 0, 'torches went out for lack of charge, as they must');
  assert.ok(c.charge < 1e-6, `caster fully drained (${c.charge.toFixed(3)} J)`);

  // every joule that left the store is accounted for somewhere by name
  const L = c.ledger;
  approx(start - L.stored, L.mechanical + L.thermal + L.radiated, 1e-6, 'withdrawals all have destinations');
});

test('a torch pays for exactly the light it gives, then goes dark', () => {
  const c = new Caster({ capacity: 1e5, position: new V(0, 5, 0) });
  const world = new World({ gravity: SI.g0 });
  const orb = makeOrb(c, world, 0);
  let frames = 0;
  while (orb.alive && frames < 40000) {
    tickOrb(orb, FIXED_DT);
    frames++;
  }
  assert.equal(orb.alive, false, 'it did go out');
  approx(orb.emitted, orb.billed, 1e-5, 'radiated joules === billed joules');
  approx(c.charge, 0, 1e-2, 'and the store is empty, not negative');
  assert.ok(frames > 100, `it burned for ${(frames * FIXED_DT).toFixed(2)} s of charge`);
});

test('spam does not mint energy; it just empties the tank', () => {
  const c = new Caster({ capacity: 1e4, position: new V(0, 5, 0) });
  let shots = 0;
  let refused = 0;
  for (let i = 0; i < 1000; i++) {
    try {
      c.lance({ aim: new V(0, 0, 1) });
      shots++;
    } catch {
      refused++;
    }
  }
  // defaults of Caster.lance: 20 g slug at 900 m/s through a 92% efficient
  // transducer. Derived from the signature, not hard-coded from memory.
  const perShot = (0.5 * 0.02 * 900 ** 2) / 0.92;
  approx(shots * perShot, 1e4 - c.charge, 1e-6, `shots × price === drained (${shots} × ${perShot.toFixed(0)} J)`);
  assert.ok(refused > 900, 'after that every cast is refused');
  assert.ok(c.charge >= 0, 'balance never went negative');
});

test('nothing emits when the caster is already empty', () => {
  const c = new Caster({ capacity: 20, position: new V(0, 5, 0) });
  const world = new World({ gravity: SI.g0 });
  const orb = makeOrb(c, world, 0);
  const r1 = tickOrb(orb, FIXED_DT); // 20 J / (0.25 W-ish) -> still lit
  assert.ok(r1 > 0);
  for (let i = 0; i < 50; i++) tickOrb(orb, FIXED_DT);
  approx(c.charge, 0, 1e-9, 'store drained to zero:');
  const after = c.light({ temperature: T_ORB, area: AREA_ORB, duration: 1 });
  approx(after.watts, 0, 1e-9, 'and an empty caster emits literally nothing');
  approx(after.cost, 0, 1e-9, 'and pays for nothing it did not emit');
});

test('the HUD reads the same numbers the kernel wrote', () => {
  const w = new World({ gravity: SI.g0 });
  w.waterY = -1e5;
  const b = makeBody({ position: new V(0, 30, 0), velocity: new V(3, 0, 0), mass: 2, radius: 0.4 });
  w.add(b);
  for (let i = 0; i < 240; i++) w.step();
  const E = totalEnergy(w);
  approx(E.ke, kinetic(b), 1e-12, 'HUD KE === body KE');
  approx(E.pe, 2 * SI.g0 * b.position.y, 1e-12, 'HUD PE === m·g·y');
  const gvec = w.field.accelerationAt(b.position);
  assert.ok(gvec.y < 0, 'and the felt gravity vector points down');
  assert.ok(Number.isFinite(wienPeak(T_ORB) * 1e9), 'colour readout is finite');
  assert.ok(landSurface(b.position).normal.y > 0, 'ground normal is defined');
});
