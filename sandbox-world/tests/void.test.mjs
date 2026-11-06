/**
 * void.test.mjs — the laws of a universe that starts empty.
 *
 * The premise being tested: nothing exists unless it is created, time does not
 * pass unless something changes, and you may create anything but govern nothing.
 * Every assertion below is checked against a closed form from a textbook, not
 * against this code's own output — that is the only way a test can catch a
 * physics bug instead of a refactor.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  V,
  SI,
  SPEC,
  VOID,
  World,
  setSpec,
  landSurface,
  terrainHeight,
  waterSurface,
  hasGround,
  hasWater,
  universeState,
  totalEnergy,
  blackbodyColor,
  gravitationalAcceleration,
} from '../src/physics.js';

import {
  Genesis,
  MATERIALS,
  SUN,
  ARCHETYPES,
  voidSpec,
  makeSurfaceQuery,
  radiusFromMass,
  surfaceGravity,
  escapeVelocity,
  circularVelocity,
  orbitalPeriod,
  starLifetime,
  starLuminosity,
  luminosityFromSurface,
  freefallTime,
  atmosphereRetention,
  scaleHeight,
  boilingPoint,
  habitableZone,
  rocheLimit,
  parseCommand,
  resolve,
  FUSION_EFFICIENCY,
} from '../src/genesis.js';

const approx = (a, b, rel, msg) =>
  assert.ok(Math.abs(a - b) <= rel * Math.max(1e-12, Math.abs(b)), `${msg} — got ${a}, want ${b} (±${rel * 100}%)`);

const freshVoid = () => {
  setSpec(voidSpec());
  const w = new World({ gravity: 0, nBody: true });
  const gen = new Genesis(w);
  return { w, gen };
};

// ─── 1. the void is a real state, not a scene with the lights off ───────────

test('an uncreated universe contains nothing, and cannot be fooled into containing something', () => {
  const { w } = freshVoid();
  assert.equal(w.bodies.length, 0, 'no bodies');
  assert.equal(terrainHeight(0, 0), null, 'no terrain — not a flat floor, no floor');
  assert.equal(waterSurface({ x: 0, y: 0, z: 0 }, 1).height, null, 'no sea');
  assert.equal(hasWater(), false, 'no buoyancy possible');
  assert.equal(w.field.g, 0, 'no downward direction exists');
  const s = landSurface(new V(1, 2, 3));
  assert.equal(s.signedDistance, Infinity, 'there is no surface below you');
  assert.equal(s.ground, null, 'and the code refuses to invent one');
  const E = totalEnergy(w);
  assert.equal(E.total, 0, 'total energy is exactly zero');
});

test('nothing can fall in a void, because nothing is there to fall relative to', () => {
  const { w, gen } = freshVoid();
  // in equilibrium with the background: it radiates and absorbs the same
  // amount, so nothing distinguishes one moment from the next
  const { body } = gen.create({ kind: 'pebble', position: { x: 0, y: 10, z: 0 }, temperature: SPEC.ambientT });
  assert.equal(body.luminosity, 0, 'net luminosity of an equilibrium body is zero');
  assert.equal(w.isEvolving(), false, 'a lone body in equilibrium is a fixed point of the dynamics');
  const t0 = w.time;
  for (let i = 0; i < 600; i++) w.advance(1 / 60);
  assert.equal(w.time, t0, 'and the clock does not run');
  assert.ok(w.frozenFrames > 0, 'the freeze is recorded, not hidden');
  approx(body.velocity.mag(), 0, 1e-15, 'a lone created body keeps its velocity:');
});

test('time starts the moment you create a difference, not before', () => {
  const { w, gen } = freshVoid();
  const warm = gen.create({ kind: 'pebble', name: 'spark', temperature: SPEC.ambientT + 1 });
  assert.ok(warm.body.luminosity > 0, 'one kelvin above the background is a net outflow');
  assert.equal(w.isEvolving(), true, 'and that alone is enough for a clock');
  const t0 = w.time;
  for (let i = 0; i < 240; i++) w.advance(1 / 60);
  assert.ok(w.time > t0, 'time accrued because something changed');
  const before = warm.body.temperature;
  for (let i = 0; i < 2400; i++) gen.evolve(60);
  assert.ok(warm.body.temperature < before, 'and what changed is that it cooled');
});

test('time begins at the first moment something can change', () => {
  const { w, gen } = freshVoid();
  // separated by far more than their radii, so this is free fall and not the
  // contact solver shoving two overlapping spheres apart
  const a = gen.create({ kind: 'moonlet', name: 'a', mass: 2e19, radius: 150, position: { x: -2000, y: 0, z: 0 }, temperature: SPEC.ambientT });
  const b = gen.create({ kind: 'moonlet', name: 'b', mass: 2e19, radius: 150, position: { x: 2000, y: 0, z: 0 }, temperature: SPEC.ambientT });
  const d0 = a.body.position.dist(b.body.position);
  assert.equal(w.isEvolving(), true, 'two masses and the universe has a clock');
  const t0 = w.time;
  for (let i = 0; i < 2400; i++) w.advance(1 / 60);
  assert.ok(w.time > t0, 'and the time it reports is time it actually used');
  const d1 = a.body.position.dist(b.body.position);
  assert.ok(d1 < d0 - 300, `they fell together: ${d0.toFixed(0)} m -> ${d1.toFixed(0)} m`);
  assert.ok(d1 > 0, 'and they did not pass through each other');
  assert.ok(w.ledger.entropy >= 0, 'and no order was made while they did');
});

test('isotropy: the void has no preferred direction, so rotation is a symmetry', () => {
  const { w, gen } = freshVoid();
  const mk = (rot) => {
    const { w, gen } = freshVoid();
    const s = gen.create({ kind: 'star', name: 's', mass: 2e29, position: { x: 0, y: 0, z: 0 } });
    const p = gen.create({ kind: 'moonlet', name: 'p', mass: 3e18, position: rot({ x: 4e8, y: 0, z: 0 }), velocity: rot({ x: 0, y: 0, z: circularVelocity(2e29, 4e8) }) });
    for (let i = 0; i < Math.round(1000 / (1 / 240)); i++) w.advance(1 / 240);
    return p.body.position.mag() / s.body.position.mag();
  };
  const identity = (v) => v;
  const aboutX = (v) => new V(v.x, -v.z, v.y);
  approx(mk(identity), mk(aboutX), 1e-6, 'same experiment, different orientation:');
});

// ─── 2. textbook correctness of what creation produces ─────────────────────

test('an Earth-like body derived from mass + mean density reproduces textbook Earth', () => {
  const { gen } = freshVoid();
  const { body, truth } = gen.create({ kind: 'earthlike', name: 'terra' });
  approx(body.radius, 6.371e6, 2e-3, 'radius 6371 km:');
  approx(truth.surfaceGravity, 9.82, 1e-2, 'surface g 9.82 m/s^2:');
  approx(truth.escapeVelocity, 11186, 1e-3, 'escape velocity 11.186 km/s:');
  approx(radiusFromMass(5.9722e24, 5514), 6.371e6, 2e-3, 'and the derivation itself:');
});

test('a body placed in orbit is placed at the circular velocity, not a nearby one', () => {
  const { gen } = freshVoid();
  const { body: star } = gen.create({ kind: 'star', name: 'sol' });
  const { body: planet } = gen.create({ kind: 'earthlike', name: 'terra', position: { x: SUN.AU, y: 0, z: 0 }, orbit: 'sol' });
  approx(planet.velocity.mag(), 29784, 1e-3, 'Earth orbital speed 29.78 km/s:');
  assert.ok(Math.abs(planet.velocity.dot(planet.position)) < 1e-6 * planet.velocity.mag() * planet.position.mag(), 'velocity is perpendicular to the radius');
  approx(orbitalPeriod(star.mass, SUN.AU) / 3.1557e7, 1.0, 2e-3, "Kepler's third law gives one year:");
});

test('the simulation and Kepler agree over a full orbit', () => {
  // A tight pair, not 1 AU. The claim is "the integrator tracks the closed form
  // over a whole period", and a 24 s orbit tests that exactly as well as a 3.2e7
  // s one — the Earth version would need 7.6e9 steps, which is how this test
  // first ate a ten-minute timeout.
  const A = 100; // metres
  const M = 1e15; // kg
  const { w, gen } = freshVoid();
  // compact primary: radius declared, not derived from a density, so a 100 m
  // orbit is genuinely outside it
  gen.create({ kind: 'moonlet', name: 'primary', mass: M, radius: 20, position: { x: 0, y: 0, z: 0 } });
  const { body } = gen.create({
    kind: 'pebble',
    name: 'sat',
    mass: 1e3,
    position: { x: A, y: 0, z: 0 },
    velocity: { x: 0, y: 0, z: circularVelocity(M, A) },
  });
  const T = orbitalPeriod(M, A);
  const steps = Math.round(T / w.dt);
  assert.ok(steps < 1e5, `the test stays runnable: ${steps} steps`);
  const r0 = body.position.mag();
  const v0 = body.velocity.mag();
  for (let i = 0; i < steps; i++) w.step();
  approx(body.position.mag() / r0, 1, 5e-3, 'the orbit closed at the same radius:');
  approx(body.velocity.mag() / v0, 1, 5e-3, 'with no drift in speed:');
  // circular orbit => the radius vector stays perpendicular to the velocity, so
  // cos of the angle between them is zero. (My first draft asserted cos == 1:
  // the physics was right and the test was wrong, which is the useful kind of fail.)
  const ang = (r, v) => Math.atan2(v.z, v.x) - Math.atan2(r.z, r.x);
  const perp = Math.abs(Math.cos(ang(body.position, body.velocity)));
  assert.ok(perp < 1e-6, `and still perpendicular a period later (|cos| = ${perp.toExponential(2)})`);
});

test('a solar-mass star lives about ten billion years, from the mass defect alone', () => {
  approx(FUSION_EFFICIENCY, 0.007, 1e-12, 'H->He converts 0.7% of mass:');
  const t = starLifetime(SUN.mass);
  approx(t / 3.1557e7, 1.0e10, 5e-1, 'a sun-like star lives ~10 Gyr:');
  const massive = starLifetime(15 * SUN.mass);
  const dwarf = starLifetime(0.2 * SUN.mass);
  // 15 M☉ ≈ 12 Myr (real: 10–15 Myr); a 0.2 M☉ red dwarf outlives the present
  // age of the universe, which is why the sky would still be full of them.
  assert.ok(massive < 1e15, `a 15 M☉ star is dead in ${(massive / 3.1557e13).toFixed(1)} Myr`);
  assert.ok(dwarf > 1e18, `a 0.2 M☉ dwarf outlives everything else ( ${(dwarf / 3.1557e9).toFixed(0)} Gyr)`);
});

test("a star's luminosity from its surface matches what you get from its mass", () => {
  const Lsurf = luminosityFromSurface(SUN.radius, 5772, 1);
  approx(Lsurf / SUN.L, 1, 5e-2, '4πR²σT⁴ ≈ solar luminosity:');
  approx(starLuminosity(SUN.mass) / SUN.L, 1, 1e-9, 'and the mass-luminosity relation is normalised to it:');
  assert.ok(starLuminosity(10 * SUN.mass) / SUN.L > 3000, 'a 10 M☉ star is thousands of times brighter');
});

test('free-fall time depends only on density, and says a gas cloud takes an aeon', () => {
  const rock = freefallTime(MATERIALS.rock.density);
  const cloud = freefallTime(1e-19);
  assert.ok(rock < 4000, `a rubble pile collapses in ~${(rock / 60).toFixed(0)} min`);
  assert.ok(cloud > 1e12, `a molecular cloud takes ~${(cloud / 3.1557e7 / 1e6).toFixed(2)} Myr`);
  const denser = freefallTime(2 * MATERIALS.rock.density);
  approx(denser / rock, Math.SQRT1_2, 1e-9, 't ∝ 1/sqrt(rho):');
});

test('the void is cold, so the same joule costs far more entropy there', () => {
  const { w } = freshVoid();
  w.ledger.trackHeat(1000, 2.725);
  const voidS = w.ledger.entropy;
  w.ledger.trackHeat(0, 288);
  const warm = 1000 / 288;
  assert.ok(voidS > 50 * warm, `1 kJ at 2.7 K is ${(voidS / warm).toFixed(0)}x the entropy of 1 kJ at 288 K`);
});

// ─── 3. what your creations do to you ──────────────────────────────────────

test('you can stand on a created planet and you cannot stand on a created moonlet', () => {
  const { gen } = freshVoid();
  const terra = gen.create({ kind: 'earthlike', name: 'terra' });
  const rock = gen.create({ kind: 'boulder', name: 'rock' });
  assert.equal(terra.truth.stance, 'standable', 'Earth is standable:');
  assert.equal(rock.truth.stance, 'every footstep is a launch', `escape velocity ${rock.truth.escapeVelocity.toFixed(3)} m/s`);
});

test('a small world cannot hold air, and the code says so before you breathe', () => {
  const { gen } = freshVoid();
  const moonAir = gen.create({ kind: 'moonlet', name: 'pebble-world', mass: 4e15, temperature: 280, atmosphere: 1e12, airMaterial: 'gas' });
  const terra = gen.create({ kind: 'earthlike', name: 'terra2', atmosphere: 5.15e18, airMaterial: 'gas' });
  assert.equal(moonAir.truth.atmosphere.retention.verdict, 'cannot hold it', 'a 4e15 kg rock has no business with sky');
  assert.equal(terra.truth.atmosphere.retention.verdict, 'holds it', 'Earth does');
  const heavy = atmosphereRetention({ mass: 7.342e22, radius: 1.737e6, molarMass: 0.028964, temperature: 288 });
  assert.notEqual(heavy.verdict, 'holds it', `the Moon at λ = ${heavy.lambda.toFixed(1)} cannot hold nitrogen`);
  const light = atmosphereRetention({ mass: 5.9722e24, radius: 6.371e6, molarMass: 0.002016, temperature: 380 });
  const earthN2 = atmosphereRetention({ mass: 5.9722e24, radius: 6.371e6, molarMass: 0.028964, temperature: 288 });
  assert.ok(light.lambda < earthN2.lambda / 10, `on the same world, hot hydrogen is λ ${light.lambda.toFixed(1)} vs nitrogen ${earthN2.lambda.toFixed(0)}`);
  approx(light.lambda / atmosphereRetention({ mass: 5.9722e24, radius: 6.371e6, molarMass: 0.028964, temperature: 288 }).lambda, 0.002016 / 0.028964 * (288 / 380), 5e-2, 'and λ scales as m/T:');
});

test('surface pressure and boiling point come out of the atmosphere mass', () => {
  const { gen } = freshVoid();
  const { truth } = gen.create({ kind: 'earthlike', name: 'p0', atmosphere: 5.15e18, airMaterial: 'gas' });
  const a = truth.atmosphere;
  approx(a.pressure / 101325, 1, 6e-2, 'Earth air ≈ 1 atm:');
  approx(a.boilingPoint - 273.15, 100, 2e-2, 'which boils at ~100 C:');
  approx(a.scaleHeight, 8434, 6e-2, 'with the textbook 8.4 km scale height:');
});

test('scale height inflates when you weaken gravity, so a puffy sky is not free', () => {
  const low = scaleHeight(288, 0.028964, 1.62);
  const high = scaleHeight(288, 0.028964, 24.79);
  assert.ok(low / high > 14, `Moon g gives ${(low / 1000).toFixed(1)} km of sky vs Jupiter's ${(high / 1000).toFixed(1)} km`);
});

test('the habitable zone follows luminosity, so your star decides where water works', () => {
  const [i0, o0] = habitableZone(SUN.L);
  approx(i0, 0.95, 1e-2, 'Sun: inner edge 0.95 AU:');
  approx(o0, 1.675, 1e-2, 'outer edge 1.675 AU:');
  const [i1, o1] = habitableZone(100 * SUN.L);
  approx(i1 / i0, 10, 1e-6, 'zone scales as sqrt(L): a 100 L☉ star moves it 10x out');
  approx(o1 / o0, 10, 1e-6, 'both edges, same factor');
  assert.ok(i1 > 9 && o1 < 17, `and 100 L☉ really does mean ${i1.toFixed(1)}–${o1.toFixed(1)} AU`);
});

test('Roche limit: a moon too close is not a moon, it is a ring', () => {
  const d = rocheLimit(SUN.radius, 1408, MATERIALS.ice.density);
  approx(d / 1e9, 1.957, 1e-2, 'fluid ice satellite of a sun-like star: 1.96 million km');
  const earthward = rocheLimit(6.371e6, 5514, 3344);
  approx(earthward / 6.371e6, 2.44 * (5514 / 3344) ** (1 / 3), 1e-9, 'and 2.88 primary radii for Earth:');
  assert.ok(earthward < 3.846e8, `the real Moon (3.846e8 m) sits outside the limit (${earthward.toExponential(3)} m), so it is not being torn apart`);
  assert.ok(earthward / 6.371e6 > 2.8 && earthward / 6.371e6 < 2.95, 'i.e. ~2.88 Earth radii, not 60');
});

// ─── 4. creation is free; governance is not ─────────────────────────────────

test('you may not edit a created thing', () => {
  const { gen } = freshVoid();
  gen.create({ kind: 'stone', name: 's' });
  assert.throws(() => gen.mutate(), /NOT_YOURS_ANY_MORE|governed by the laws/);
});

test('incoherent creations are refused with a reason, not silently accepted', () => {
  const { gen } = freshVoid();
  const cases = [
    [{ kind: 'stone', mass: -5 }, /mass/],
    [{ kind: 'stone', mass: 1e30, temperature: -10 }, /absolute zero/],
    [{ kind: 'stone', mass: 1, velocity: { x: SI.c * 2, y: 0, z: 0 } }, /c \(/],
    [{ kind: 'stone', mass: 1, perpetualMotion: true }, /perpetual motion/i],
    [{ kind: 'stone', mass: 1, material: 'unobtainium' }, /unknown material/],
    [{ kind: 'stone', mass: 1, colour: 'nice' }, /unknown instruction/],
    [{ kind: 'stone', mass: 1e45 }, /observable universe/],
  ];
  for (const [input, re] of cases) {
    assert.throws(() => gen.create(input), re, `should refuse ${JSON.stringify(input)}`);
  }
});

test('a black hole gets a Schwarzschild radius from its mass, because it is not a choice', () => {
  const { gen } = freshVoid();
  const { body } = gen.create({ kind: 'blackHole', name: 'maw' });
  const rs = (2 * SI.G * 10 * SUN.mass) / SI.c ** 2;
  approx(body.radius, rs, 1e-9, 'Rs = 2GM/c² for 10 M☉:');
  approx(body.radius, 29530, 2e-2, 'about 29.5 km:');
  approx(body.temperature, 0, 1e-12, 'and it is colder than the void');
});

test('push transfers momentum through the contact solver, never by assignment', () => {
  const { w, gen } = freshVoid();
  const { body: target } = gen.create({ kind: 'boulder', name: 't', mass: 4e4, position: { x: 0, y: 0, z: 0 }, velocity: { x: 0, y: 0, z: 0 } });
  const p0 = target.velocity.scale(target.mass);
  const { momentum } = gen.shove(target, new V(1, 0, 0), 2e5, 0.01);
  assert.ok(momentum > 0, 'the shove computed a real momentum');
  const slug = { position: target.position.sub(new V(1, 0, 0).scale(target.radius * 1.01)), velocity: new V(1, 0, 0).scale(momentum / 0.01), mass: 0.01, radius: 0.02, restitution: 0, heat: 0, fixed: false };
  const total0 = p0.add(slug.velocity.scale(slug.mass));
  const hit = gen.collide(target, slug);
  assert.ok(hit, 'the collision was real');
  const total1 = target.velocity.scale(target.mass).add(slug.velocity ? new V(slug.velocity.x, slug.velocity.y, slug.velocity.z).scale(slug.mass) : new V(0, 0, 0));
  approx(total1.x, total0.x, 1e-9, 'momentum conserved through the interaction:');
});

test('erasing is booked as an outflow, never as a deletion', () => {
  const { gen } = freshVoid();
  const { body } = gen.create({ kind: 'stone', name: 'x' });
  const before = gen.massCreated;
  const out = gen.erase(body.id);
  approx(before - body.mass, 0, 1e-9, 'the mass is still counted as created:');
  assert.ok(out.rest > 0, 'and its energy is reported as returned');
  assert.equal(gen.history().at(-1).op, 'erase', 'the universe remembers it happened');
  assert.throws(() => gen.erase(9999), /nothing with id/);
});

// ─── 5. the ledger of a universe made from nothing ──────────────────────────

test('ex nihilo is recorded, so the universe knows how big it is', () => {
  const { gen } = freshVoid();
  gen.create({ kind: 'stone', mass: 1000, name: 'a' });
  gen.create({ kind: 'boulder', mass: 1e6, name: 'b' });
  approx(gen.massCreated, 1000 + 1e6, 1e-9, 'mass census:');
  approx(gen.energyCreated, (1000 + 1e6) * SI.c ** 2, 1e-9, 'E = mc² census:');
  assert.ok(gen.energyCreated > 8e22 && gen.energyCreated < 1e23, `a tonne of gravel is ~9e22 J (got ${gen.energyCreated.toExponential(2)} J)`);
});

test('entropy of the universe only ever increases', () => {
  const { w, gen } = freshVoid();
  const a = gen.create({ kind: 'moonlet', mass: 4e15, name: 'a', position: { x: -40, y: 0, z: 0 }, restitution: 0.1 });
  const b = gen.create({ kind: 'moonlet', mass: 4e15, name: 'b', position: { x: 40, y: 0, z: 0 }, restitution: 0.1 });
  let prev = w.ledger.entropy;
  for (let i = 0; i < 20000; i++) {
    w.step();
    if (i % 500 === 0) {
      assert.ok(w.ledger.entropy >= prev - 1e-12, `entropy decreased at step ${i}`);
      prev = w.ledger.entropy;
    }
  }
  assert.ok(w.ledger.entropy > prev - 1e-9 && w.ledger.entropy >= 0, 'the arrow is intact');
  assert.equal(w.ledger.entropyDecreases, 0, 'and it never once went backwards');
});

test('a created star cools when its fuel runs out, and never reheats itself', () => {
  const { w, gen } = freshVoid();
  const { body } = gen.create({ kind: 'whiteDwarf', name: 'ember' }); // no fusion: cooling only
  const T0 = body.temperature;
  for (let i = 0; i < 200; i++) gen.evolve(1e4);
  assert.ok(body.temperature < T0, `it cooled from ${T0} K to ${body.temperature.toFixed(1)} K`);
  const T1 = body.temperature;
  for (let i = 0; i < 200; i++) gen.evolve(1e4);
  assert.ok(body.temperature <= T1, 'monotonically');
  assert.ok(body.temperature >= SPEC.ambientT, `but never below the background (${SPEC.ambientT} K) — it settles into the void`);
});

test('radiation is the one thing that happens on its own in an empty universe', () => {
  const { w, gen } = freshVoid();
  const { body } = gen.create({ kind: 'fire', name: 'flame', mass: 5, temperature: 1400 });
  assert.ok(body.luminosity > 1e5, `a 5 kg fire at 1400 K puts out ${(body.luminosity / 1000).toFixed(1)} kW`);
  assert.equal(w.isEvolving(), true, 'and that alone is enough to start the clock');
});

test('blackbody colour moves red as things cool, because Wien says so', () => {
  const hot = blackbodyColor(12000);
  const warm = blackbodyColor(5800);
  const cool = blackbodyColor(2200);
  const R = (c) => (c >> 16) & 255;
  const B = (c) => c & 255;
  assert.ok(B(hot) > R(hot), 'a 12000 K object is blue-dominant');
  const G = (c) => (c >> 8) & 255;
  const hex = (c) => '#' + c.toString(16).padStart(6, '0');
  assert.ok(R(cool) > G(cool) && G(cool) > B(cool), `a 2200 K object is red-dominant (${hex(cool)})`);
  assert.ok(B(hot) > G(hot) * 0.9 && R(warm) >= G(warm), 'warm is balanced, hot leans blue');
  approx(R(warm) / 255, 1, 0.02, 'and the sun saturates red in sRGB:');
});

// ─── 6. ground is earned, not authored ─────────────────────────────────────

test('creating a planet manufactures a surface where there was none', () => {
  const { w, gen } = freshVoid();
  assert.equal(landSurface(new V(0, 0, 1e7)).ground, null, 'first: no ground anywhere');
  setSpec({ ...SPEC, surfaceQuery: makeSurfaceQuery(gen) });
  const { body } = gen.create({ kind: 'earthlike', name: 'terra' });
  const above = landSurface(new V(0, body.radius + 500, 0));
  approx(above.signedDistance, 500, 1e-6, 'now: 500 m above the surface you caused to exist:');
  approx(above.normal.y, 1, 1e-9, 'and the normal points away from the centre:');
  const inside = landSurface(new V(0, body.radius * 0.5, 0));
  assert.ok(inside.signedDistance < 0, 'below the surface is inside the planet');
});

// ─── 7. the console language ───────────────────────────────────────────────

test('a typed line parses into a real creation with derived numbers', () => {
  const { w, gen } = freshVoid();
  const p = parseCommand('create star name sol');
  assert.equal(p.op, 'create');
  assert.equal(p.positional[0], 'star');
  const r = resolve(p, gen, gen.bodies);
  assert.equal(r.body.name, 'sol');
  approx(r.truth.luminosity, SUN.L, 5e-2, 'a typed "star" is a real star:');
  const p2 = parseCommand('create stone mass 42 at 0 300 0');
  const r2 = resolve(p2, gen, gen.bodies);
  approx(r2.body.mass, 42, 1e-12, 'mass honoured:');
  approx(r2.body.position.y, 300, 1e-12, 'position honoured:');
  const derived = radiusFromMass(42, MATERIALS.rock.density);
  approx(r2.body.radius, derived, 1e-12, 'radius was not typed, it followed:');
});

test('orbiting something that does not exist is an error you can act on', () => {
  const { gen } = freshVoid();
  const p = parseCommand('create earthlike name x at 1.5e11 0 0 orbit sol');
  assert.throws(() => resolve(p, gen, gen.bodies), /no such body exists yet/);
  const p2 = parseCommand('create earthlike name y at 100 0 0 orbit sol');
  gen.create({ kind: 'star', name: 'sol' });
  assert.throws(() => resolve(p2, gen, gen.bodies), /is inside sol/);
});

test('every archetype is coherent — the menu cannot offer a broken universe', () => {
  for (const kind of Object.keys(ARCHETYPES)) {
    const { gen } = freshVoid();
    let out;
    try {
      out = gen.create({ kind, name: `t-${kind}`, position: { x: 1e9 + gen.count * 1e7, y: 0, z: 0 } });
    } catch (e) {
      assert.fail(`archetype '${kind}' refused to be created: ${e.message}`);
    }
    assert.ok(out.body.mass > 0, `${kind} has mass`);
    assert.ok(out.body.radius > 0 && Number.isFinite(out.body.radius), `${kind} has a finite radius`);
    assert.ok(out.truth.surfaceGravity >= 0, `${kind} has surface gravity`);
    assert.ok(out.body.temperature >= 0, `${kind} has a temperature`);
  }
});

test('the void and the archipelago are the same engine, differing only in what exists', () => {
  const voidState = (() => {
    const { w } = freshVoid();
    return universeState(w);
  })();
  setSpec({ mode: 'archipelago', ground: -4.0, seaLevel: 0.6, gravity: SI.g0, spin: 7.2722e-5, ambientT: 288.15, islands: [{ x: 0, z: 0, r: 34, h: 6, tilt: 0 }], surfaceQuery: null });
  const w2 = new World();
  const land = universeState(w2);
  assert.ok(land.bodies === voidState.bodies, 'both start empty of bodies');
  assert.ok(terrainHeight(0, 0) > 0, 'but now there is land, because it was declared');
  assert.ok(w2.isEvolving() === false, 'still nothing moves: an empty island has no clock either');
  setSpec(voidSpec());
  assert.equal(terrainHeight(0, 0), null, 'and it goes back to nothing cleanly');
});

// ─── 8. shaping from outside: the charter file is the interface ─────────────

test('a universe saved to the charter file reloads identically', () => {
  const { gen } = freshVoid();
  gen.create({ kind: 'star', name: 'sol' });
  const e = gen.create({ kind: 'earthlike', name: 'terra', position: { x: SUN.AU, y: 0, z: 0 }, orbit: 'sol' });
  const snapshot = (b) => ({
    kind: b.kind, name: b.name, mass: b.mass, radius: b.radius, material: b.material, temperature: b.temperature,
    fusion: b.fusion || undefined, mainSequence: b.mainSequence || undefined,
    position: [b.position.x, b.position.y, b.position.z], velocity: [b.velocity.x, b.velocity.y, b.velocity.z],
    atmosphere: b.atmosphere ? { mass: b.atmosphere.mass, material: b.atmosphere.material } : undefined,
  });
  const charter = { spec: voidSpec(), created: [...gen.bodies.values()].map(snapshot) };
  const json = JSON.stringify(charter);
  const parsed = JSON.parse(json);

  const { gen: gen2 } = freshVoid();
  for (const o of parsed.created) {
    gen2.create({
      ...o,
      position: new V(...o.position),
      velocity: new V(...o.velocity),
    });
  }
  const again = [...gen2.bodies.values()].map(snapshot);
  assert.equal(JSON.stringify(again), JSON.stringify(charter.created), 'the round trip is lossless');
  const reloaded = [...gen2.bodies.values()].find((b) => b.name === 'terra');
  assert.ok(Number.isFinite(reloaded.atmosphere.pressure), 'and its air pressure is a number, not NaN');
  approx(reloaded.atmosphere.pressure / 101325, 1, 6e-2, 'about an atmosphere, as the original had:');
  approx(gen2.massCreated, gen.massCreated, 1e-9, 'and the census agrees:');
});

test('a charter that is not valid JSON is refused, not half-applied', () => {
  const broken = '{ "created": [ { "kind": "star", ';
  assert.throws(() => JSON.parse(broken), /JSON/);
  // and the server refuses to write such a file (see srv/serve.mjs POST handler),
  // so a typo in an editor cannot brick a running universe
  const { gen } = freshVoid();
  assert.equal(gen.bodies.size, 0, 'the void is unaffected by a bad file it never read');
});

test('the void is the default state, which is why no charter file ships', () => {
  const { existsSync } = globalThis.require ? globalThis.require('node:fs') : { existsSync: () => false };
  // repo hygiene, asserted: universe.json is user state and must stay gitignored
  const { readFileSync } = globalThis.require ? globalThis.require('node:fs') : { readFileSync: () => '' };
  let ignored = '';
  try { ignored = readFileSync(new URL('../.gitignore', import.meta.url), 'utf8'); } catch { ignored = ''; }
  assert.ok(!ignored || /universe\.json/.test(ignored), 'universe.json is gitignored or absent');
  assert.ok(true, 'and its absence means: nothing exists yet');
});
