/**
 * genesis.js — creation, and everything that follows from it.
 *
 * The premise this file exists to serve, as stated:
 *
 *   "A null universe. Timeless. Anything can be created.
 *    Nothing exists unless it has been created inside it."
 *
 * Three mechanical commitments follow, and they are the whole design:
 *
 * 1. EX NIHILO IS ACCOUNTED, NOT FREE.
 *    The void's budget starts at exactly zero. Every object you create is
 *    logged with its real mass-energy content (m·c², plus its thermal content
 *    m·cp·T). Nothing is silently conjured: the universe keeps a ledger of what
 *    was introduced, by whom, at what timestamp. Creation is free because you
 *    are outside the bookkeeping — but it is *counted*, so the universe always
 *    knows how big it is.
 *
 * 2. CREATION IS FREE, GOVERNANCE IS NOT.
 *    You may declare anything into existence. The instant you do, it belongs to
 *    the laws, not to you. `mutate()` throws. You cannot nudge a planet onto a
 *    better orbit, cool a star by willing it, or edit a rock's velocity. You can
 *    only *interact*: throw something at it (momentum is exchanged, never
 *    assigned), or make another thing next to it. Omnipotence with a hard stop
 *    at t=0+ is what makes the world feel real instead of obedient.
 *
 * 3. TIME IS RELATIONAL.
 *    A universe with one body in it has no duration: there is no change to
 *    measure it with. The clock starts when your first creation can actually
 *    fall, orbit, radiate or collide — and it is derived from what happened, not
 *    from a wall clock. `world.timeline()` is the only history a void can have.
 *
 * Everything else here is consequence: given what you made, reality computes
 * what it does to you, how long it lasts, and whether you can stand on it.
 */

import {
  V,
  SI,
  SPEC,
  makeBody,
  resolvePair,
  netLuminosity,
  kinetic,
  landSurface,
  wienPeak,
  exitance,
  blackbodyColor,
} from './physics.js';

// ---------------------------------------------------------------------------
// Materials: not a colour palette. Each one is a set of real transport and
// thermal properties, because the consequences depend on them.
// ---------------------------------------------------------------------------

export const MATERIALS = Object.freeze({
  vacuum: { density: 0, cp: 0, label: 'nothing at all' },
  ice: { density: 917, cp: 2093, label: 'water ice' },
  water: { density: 1000, cp: 4184, label: 'liquid water' },
  rock: { density: 2650, cp: 840, label: 'silicate rock' },
  iron: { density: 7874, cp: 449, label: 'iron-nickel' },
  carbon: { density: 3515, cp: 710, label: 'crystalline carbon' },
  gas: { density: 1.275, cp: 919, label: 'nitrogen-oxygen air', gamma: 1.4, molarMass: 0.028964 },
  co2: { density: 1.977, cp: 846, label: 'carbon dioxide', gamma: 1.3, molarMass: 0.04401 },
  h2: { density: 0.08988, cp: 14300, label: 'hydrogen', gamma: 1.41, molarMass: 0.002016 },
  plasma: { density: 2e-4, cp: 1.0, label: 'fully ionised hydrogen', emissivity: 1 },
  life: { density: 1000, cp: 3500, label: 'wet carbon machinery' },
});

// ---------------------------------------------------------------------------
// Closed-form astrophysics. These are the functions that turn "I want a star"
// into "here is what your star does to you, and for how long".
// ---------------------------------------------------------------------------

export const SUN = Object.freeze({ mass: 1.98892e30, radius: 6.957e8, L: 3.828e26, T: 5772, AU: 1.495978707e11 });

/** Radius of a self-gravitating sphere from mass and material density. */
export const radiusFromMass = (mass, density) => Math.cbrt((3 * Math.max(mass, 1e-30)) / (4 * Math.PI * Math.max(density, 1e-9)));

/** Main-sequence mass-radius: R ∝ M^0.8. Not a guess; a fitted stellar relation. */
export const starRadius = (mass) => SUN.radius * (mass / SUN.mass) ** 0.8;

/** Mass-luminosity: L ∝ M^3.5 on the main sequence. */
export const starLuminosity = (mass) => SUN.L * (mass / SUN.mass) ** 3.5;

/** L = 4πR²εσT⁴, from the surface. */
export const luminosityFromSurface = (radius, T, emissivity = 1) => 4 * Math.PI * radius * radius * emissivity * exitance(T, emissivity);

/** Surface gravity and escape velocity — the two numbers that decide whether you can stand on something or jump off it. */
export const surfaceGravity = (mass, radius) => (SI.G * mass) / Math.max(radius * radius, 1e-18);
export const escapeVelocity = (mass, radius) => Math.sqrt((2 * SI.G * mass) / Math.max(radius, 1e-18));

/** Circular orbit speed and Kepler's third law period at radius a about mass M. */
export const circularVelocity = (mass, a) => Math.sqrt((SI.G * mass) / Math.max(a, 1e-18));
export const orbitalPeriod = (mass, a) => 2 * Math.PI * Math.sqrt(Math.max(a, 1e-18) ** 3 / (SI.G * Math.max(mass, 1e-30)));

/** Roche limit for a satellite of density ρs about a primary of density ρp. */
export const rocheLimit = (primaryRadius, densityPrimary, densitySatellite) =>
  primaryRadius * 2.44 * (densityPrimary / densitySatellite) ** (1 / 3);

/** Hill sphere: how far a body's ownership of a moon reaches. */
export const hillRadius = (mass, primaryMass, a) => a * (mass / (3 * primaryMass)) ** (1 / 3);

/**
 * Free-fall (Jeans) collapse time of a uniform cloud: t = sqrt(3π / (32 G ρ)).
 * This is how long your "just make a gas cloud" takes to become a star, and it
 * depends only on density — a real and slightly shocking result: a molecular
 * cloud at 1e-19 kg/m³ takes ~10^6 years; a rock, minutes.
 */
export const freefallTime = (density) => Math.sqrt((3 * Math.PI) / (32 * SI.G * Math.max(density, 1e-30)));

/**
 * Main-sequence lifetime. Only ~10% of mass is ever fused, and the pace is set
 * by luminosity: t = 0.1·M·c²/L — which is why a 15 M☉ star burns out in ~10 Myr
 * while a 0.2 M☉ red dwarf outlives the current age of the universe.
 */
/**
 * Fuel fraction times the H->He mass defect (0.7%), over the rate it is spent:
 * t = 0.1 · 0.007 · M c² / L. Without the 0.007 you get 10^11 years for a
 * 15 M☉ star instead of ~10^7, which is the difference between "the first
 * generation of galaxies" and "nothing you will ever see".
 */
export const FUSION_EFFICIENCY = 0.007;
export const FUEL_FRACTION = 0.1;
export const starLifetime = (mass) => {
  const L = starLuminosity(mass);
  return (FUEL_FRACTION * FUSION_EFFICIENCY * mass * SI.c * SI.c) / L;
};

/**
 * Can this body hold the atmosphere you gave it?
 * Jeans parameter λ = (v_esc / v_rms)². Below ~6 the gas is gone in geological
 * time; above ~15 it is stable for the age of the solar system. This is the
 * function that stops "and then there was breathable air" from being free: air
 * on a small world, or air made of light molecules, leaves — and we can say when.
 */
export function atmosphereRetention({ mass, radius, molarMass = 0.028964, temperature = 288 }) {
  const vesc = escapeVelocity(mass, radius);
  // v_rms = sqrt(3kT/molecule), with molecule mass = molar mass / N_A. Light
  // molecules at high temperature on a small world is the losing combination.
  const vrms = Math.sqrt((3 * SI.k * Math.max(1, temperature)) / (molarMass / SI.NA));
  const lambda = (vesc / Math.max(vrms, 1e-9)) ** 2;
  // The rule of thumb actually used in planetary science is v_esc > 6 v_rms for
  // retention over the age of the solar system, i.e. lambda > 36 — not the
  // hand-wavier "15" I had here, which reported that the Moon holds an
  // atmosphere. It does not, and the test suite noticed before I did.
  const STABLE = 36; // (6)^2
  const MARGINAL = 20;
  const stable = lambda > STABLE;
  const marginal = lambda > MARGINAL && lambda <= STABLE;
  return {
    vesc,
    vrms,
    lambda,
    threshold: STABLE,
    verdict: stable ? 'holds it' : marginal ? 'leaks over aeons' : 'cannot hold it',
    // Loss rate scales like exp(-lambda): Jeans escape is a tail of the Maxwell
    // distribution, so this is a shape, not a calibrated age.
    years: stable ? Infinity : Math.max(1e3, 4.6e9 * Math.exp(-(STABLE - lambda) * 0.55)),
  };
}

/** Boiling point of water at a given surface pressure (Clausius-Clapeyron, inverted). */
export function boilingPoint(pressurePa) {
  const T0 = 373.124;
  const L = 40657; // J/mol at 100 C
  const R = 8.314462;
  return 1 / (1 / T0 - (R / L) * Math.log(Math.max(pressurePa, 1) / 101325));
}

/** Hydrostatic scale height: H = kT/(m g). Why low gravity means a puffy sky. */
export const scaleHeight = (temperature, molarMass, gravity) =>
  (8.314462 * temperature) / (molarMass * Math.max(Math.abs(gravity), 1e-9));

/**
 * Circumstellar habitable zone from the flux limits, not from a vibe:
 * inner = runaway greenhouse S=1.107, outer = maximum greenhouse S=0.356
 * (Kasting et al. 1993). d = sqrt(L/Lsun / S), which for the Sun gives
 * 0.950-1.675 AU.
 */
export const HZ_FLUX = Object.freeze({ inner: 1.107, outer: 0.356 });
export const habitableZone = (L) => [Math.sqrt(L / SUN.L / HZ_FLUX.inner), Math.sqrt(L / SUN.L / HZ_FLUX.outer)];

// ---------------------------------------------------------------------------
// Archetypes: convenient starting points, all of them derived, none of them
// magic. Every field here is either input or computed from real numbers below.
// ---------------------------------------------------------------------------

export const ARCHETYPES = {
  grain: () => ({ material: 'rock', mass: 1e-6, temperature: 278 }),
  pebble: () => ({ material: 'rock', mass: 0.05, temperature: 278 }),
  stone: () => ({ material: 'rock', mass: 25, temperature: 278 }),
  boulder: () => ({ material: 'rock', mass: 4e4, temperature: 278 }),
  ocean: () => ({ material: 'water', mass: 4e18, temperature: 285 }),
  pond: () => ({ material: 'water', mass: 1e6, temperature: 283 }),
  moonlet: () => ({ material: 'rock', mass: 4e15, temperature: 120 }),
  // Mean densities, not crust densities: a planet is differentiated, and using
  // 2650 kg/m^3 for Earth gets you g = 6.0 instead of 9.8. Using 5514 gets you
  // the textbook, which is exactly what the void test asserts.
  moon: () => ({ material: 'rock', mass: 7.342e22, density: 3344, temperature: 250 }),
  marsworld: () => ({ material: 'rock', mass: 6.4171e23, density: 3934, temperature: 210, atmosphere: 2.5e16, airMaterial: 'co2' }),
  earthlike: () => ({ material: 'rock', mass: 5.9722e24, density: 5514, temperature: 288, atmosphere: 5.15e18, airMaterial: 'gas' }),
  superearth: () => ({ material: 'rock', mass: 5 * 5.9722e24, density: 6000, temperature: 293, atmosphere: 3e19, airMaterial: 'gas' }),
  brownDwarf: () => ({ material: 'plasma', mass: 40 * SUN.mass * 0.001, temperature: 1200, fusion: false }),
  star: () => ({ material: 'plasma', mass: SUN.mass, temperature: 5772, fusion: true, mainSequence: true }),
  giantStar: () => ({ material: 'plasma', mass: 4 * SUN.mass, temperature: 4200, fusion: true, mainSequence: true }),
  blueGiant: () => ({ material: 'plasma', mass: 15 * SUN.mass, temperature: 32000, fusion: true, mainSequence: true }),
  whiteDwarf: () => ({ material: 'carbon', mass: 0.6 * SUN.mass, temperature: 9000, radius: 8.5e6 }),
  neutronStar: () => ({ material: 'iron', mass: 1.4 * SUN.mass, temperature: 6e5, radius: 11e3 }),
  blackHole: () => ({ material: 'vacuum', mass: 10 * SUN.mass, temperature: 0, eventHorizon: true }),
  fire: () => ({ material: 'gas', mass: 0.5, temperature: 1400, luminosityFraction: 1 }),
  ice: () => ({ material: 'ice', mass: 20, temperature: 260 }),
  cloud: () => ({ material: 'h2', mass: 2e4 * SUN.mass, temperature: 20, collapse: true }),
  life: () => ({ material: 'life', mass: 1e-3, temperature: 305, organism: true }),
};

// ---------------------------------------------------------------------------
// Validation: the void is permissive about *what you like* and absolute about
// what is coherent. Taste is unrestricted; contradiction is not.
// ---------------------------------------------------------------------------

export function validate(raw) {
  const input = { ...raw };
  // The console and JSON hand back plain {x,y,z}; the kernel speaks V. Coerce
  // once, here, so no downstream call has to guess which it got.
  if (input.position && !(input.position instanceof V)) input.position = V.of(input.position);
  if (input.velocity && !(input.velocity instanceof V)) input.velocity = V.of(input.velocity);
  const errors = [];
  const { mass, temperature = SPEC.ambientT, velocity = new V(0, 0, 0), material = 'rock' } = input;

  if (!Number.isFinite(mass) || mass <= 0) {
    // A body with zero mass cannot gravitate or resist, so it is not a thing.
    // (Photons are massless but never at rest; nothing here pretends to be one.)
    errors.push(`mass must be a positive finite number, got ${mass}`);
  }
  if (mass > 1e42) errors.push(`mass ${mass.toExponential(2)} kg exceeds the mass of the observable universe; refusing to write a cheque the arithmetic cannot cash`);
  if (temperature < 0) errors.push(`temperature ${temperature} K is below absolute zero. You may create cold, but only by moving heat — see chill()`);
  if (!(temperature > 0) && input.fusion) errors.push('fusion requires a temperature above absolute zero');
  const speed = velocity.mag();
  if (speed > SI.c) errors.push(`speed ${speed.toExponential(2)} m/s exceeds c (${SI.c} m/s). Relativity is not a suggestion here`);
  if (input.perpetualMotion) errors.push('a self-accelerating body is a perpetual motion machine; the void has no such mechanism');
  if (input.material && !MATERIALS[input.material]) errors.push(`unknown material '${input.material}'. Known: ${Object.keys(MATERIALS).join(', ')}`);
  if (input.radius !== undefined && !(input.radius > 0)) errors.push(`radius must be positive, got ${input.radius}`);
  if (input.density !== undefined && !(input.density > 0)) errors.push(`density must be positive, got ${input.density}`);
  // Silently dropping an instruction the user typed is the worst possible
  // failure mode in a creation engine: it looks like success.
  const KNOWN = new Set(['kind','name','mass','density','material','temperature','position','velocity','radius','restitution','atmosphere','airMaterial','fusion','mainSequence','organism','eventHorizon','collapse','luminosityFraction','orbit','perpetualMotion','orbitOf','semiMajorAxis','color']);
  for (const k of Object.keys(input)) {
    if (!KNOWN.has(k)) errors.push(`unknown instruction '${k}'. Refusing to quietly ignore something you asked for`);
  }
  const resolved = { ...input };
  if (input.eventHorizon) {
    // Not typed in: the radius of a black hole is a consequence of its mass.
    resolved.radius = (2 * SI.G * mass) / (SI.c * SI.c);
    resolved.temperature = 0; // Hawking radiation is far below the CMB for stellar masses
    resolved.hawkingT = 6.169e-8 / Math.max(mass / SUN.mass, 1e-30); // K
  }
  return { ok: errors.length === 0, errors, resolved };
}

// ---------------------------------------------------------------------------
// The creator's ledger: what has been introduced into the universe.
// ---------------------------------------------------------------------------

export class Genesis {
  constructor(world, { creatorMass = 90 } = {}) {
    this.world = world;
    this.count = 0;
    this.massCreated = 0;
    this.energyCreated = 0; // rest-mass energy, J
    this.thermalCreated = 0; // heat content above the void's background
    this.bodies = new Map(); // id -> body (identity map: creation is by reference, mutation is not)
    this.creatorMass = creatorMass;
    this.log = [];
  }

  /**
   * Bill a creation. This only ever grows — it is the universe's population
   * census, not a wallet. Deliberately NOT credited into the spendable ledger
   * bucket: the body's own kinetic and thermal energy is already counted by
   * totalEnergy(world), so booking it twice would fabricate a surplus and trip
   * the conservation audit. Ex nihilo is recorded, never laundered.
   */
  charge({ mass, temperature = SPEC.ambientT, name }) {
    const rest = mass * SI.c * SI.c;
    const mat = MATERIALS[name?.material] || MATERIALS.rock;
    const thermal = mass * (mat.cp || 0) * Math.max(0, temperature - SPEC.ambientT);
    this.massCreated += mass;
    this.energyCreated += rest;
    this.thermalCreated += thermal;
    return { rest, thermal };
  }

  /**
   * Create one thing. Returns the body, now outside your control.
   * `derive` fills in every property that physics can compute from mass and
   * material, so you can be lazy at the console and still get a consistent
   * object: give a mass, receive a radius, a surface gravity, an escape
   * velocity, a luminosity, a lifetime, and a verdict on your ability to stand
   * on it.
   */
  create(input = {}) {
    const preset = typeof input === 'string' ? { kind: input } : input;
    const base = preset.kind && ARCHETYPES[preset.kind] ? ARCHETYPES[preset.kind]() : {};
    const merged = { ...base, ...preset };
    const check = validate(merged);
    if (!check.ok) {
      const err = new Error(`refused: ${check.errors.join('; ')}`);
      err.code = 'INCOHERENT_CREATION';
      err.errors = check.errors;
      throw err;
    }

    const merged2 = { ...merged, ...check.resolved };
    const material = MATERIALS[merged2.material || 'rock'];
    const mass = merged2.mass;
    const isStar = !!merged2.mainSequence;
    const density = merged2.density ?? material.density ?? 1;
    const body_radius = merged2.radius ?? (isStar ? starRadius(mass) : radiusFromMass(mass, density));

    const body = makeBody({
      position: V.of(merged2.position ?? { x: 0, y: 0, z: 0 }),
      velocity: V.of(merged2.velocity ?? { x: 0, y: 0, z: 0 }),
      mass,
      radius: body_radius,
      // Restitution from material character, not from taste: ice and rock
      // bounce, gas, plasma and living things do not.
      restitution:
        merged2.restitution ??
        (merged2.material === 'ice' ? 0.6 : merged2.material === 'gas' || merged2.material === 'plasma' || merged2.organism ? 0.05 : 0.25),
      kind: merged2.kind || merged2.material || 'body',
    });
    // writable on purpose: World.step() writes state back onto the same object
    // (identity is how the renderer finds a body's mesh), and a read-only field
    // made that throw the instant two bodies touched.
    Object.defineProperty(body, 'id', { value: ++this.count, enumerable: true, writable: true, configurable: true });
    body.hawkingT = check.resolved.hawkingT;
    body.material = merged2.material || 'rock';
    body.temperature = merged2.temperature ?? SPEC.ambientT;
    body.cp = material.cp || 0;
    body.emissivity = material.emissivity ?? (merged2.material === 'plasma' ? 1 : 0.9);
    body.fusion = !!merged2.fusion;
    body.organism = !!merged2.organism;
    body.eventHorizon = !!merged2.eventHorizon;
    body.createdBy = 'creator';
    body.bornAt = this.world.time;
    body.color = blackbodyColor(body.temperature);
    body.name = merged2.name || `${body.kind}-${body.id}`;
    body.mainSequence = !!merged2.mainSequence;

    // An orbit is derived, not typed: v = sqrt(GM/a) perpendicular to the radius,
    // so the result is a solution of the same equations the integrator uses.
    if (merged2.orbit) {
      const primary = [...this.bodies.values()].find((b) => b.name === merged2.orbit);
      if (!primary) throw Object.assign(new Error(`cannot orbit '${merged2.orbit}': no such body exists yet`), { code: 'ORBIT_TARGET_MISSING' });
      const a = body.position.mag();
      if (a <= primary.radius * 1.02) {
        throw Object.assign(new Error(`orbit radius ${a.toExponential(2)} m is inside ${primary.name}`), { code: 'INSIDE_PRIMARY' });
      }
      const r = body.position.norm();
      const up = Math.abs(r.y) > 0.95 ? new V(1, 0, 0) : new V(0, 1, 0);
      body.velocity = r.cross(up).norm().scale(circularVelocity(primary.mass, a));
      body.orbitOf = primary.name;
      body.semiMajorAxis = a;
      body._primary = primary;
    }

    const invoice = this.charge({ mass, temperature: body.temperature, name: { material: body.material, kind: body.kind } });
    this.world.add(body);
    this.bodies.set(body.id, body);
    body.luminosity = netLuminosity(body.radius, body.temperature, SPEC.ambientT, body.emissivity);

    // An atmosphere is a separate legal act, because it is a separate physics.
    // Bound before derive() so the truth reported back includes its verdict.
    // It arrives either as a bare number of kg or, from a saved charter, as
    // { mass, material } — normalise here so every path is honest. (A saved
    // universe used to hand the object straight to the pressure formula and get
    // NaN atmospheres, which is the kind of bug a round-trip test exists to find.)
    const atm = merged2.atmosphere;
    if (atm) {
      const kg = typeof atm === 'number' ? atm : atm.mass;
      const airMaterial = (typeof atm === 'object' && atm.material) || merged2.airMaterial || 'gas';
      if (kg > 0) this.bindAtmosphere(body, kg, airMaterial, merged2);
    }

    const truth = this.derive(body);
    this.log.push({ t: this.world.time, op: 'create', id: body.id, name: body.name, mass, invoice, ...truth });
    this.world.note('create', body.name);

    return { body, invoice, truth };
  }

  /** Everything reality can compute about a body right now. Read-only. */
  derive(b) {
    const g = surfaceGravity(b.mass, b.radius);
    const vesc = escapeVelocity(b.mass, b.radius);
    const L = b.temperature > 0 ? luminosityFromSurface(b.radius, b.temperature, b.emissivity) : 0;
    const mat = MATERIALS[b.material] || MATERIALS.rock;
    const air = b.atmosphere
      ? { ...b.atmosphere, retention: atmosphereRetention({ mass: b.mass, radius: b.radius, molarMass: b.atmosphere.molarMass || 0.028964, temperature: b.temperature }) }
      : null;
    return {
      radius: b.radius,
      surfaceGravity: g,
      escapeVelocity: vesc,
      luminosity: L,
      peakNanometres: b.temperature > 0 ? wienPeak(b.temperature) * 1e9 : null,
      colour: b.temperature > 0 ? blackbodyColor(b.temperature) : 0x000000,
      // Can a 90 kg creator stand on it, or does a footstep put them into orbit?
      stance: b.organism || b.eventHorizon ? 'n/a' : vesc < 2.5 ? 'every footstep is a launch' : g > 25 ? 'your skeleton fails at ' + g.toFixed(0) + ' m/s^2' : 'standable',
      freefallTime: b.collapse ? freefallTime(mat.density) : null,
      lifetime: b.fusion ? starLifetime(b.mass) : null,
      atmosphere: air,
    };
  }

  /** Attach a gas envelope: mass, depth, retention, boiling point at the surface. */
  bindAtmosphere(body, massOfAir, airMaterial, ctx = {}) {
    const mat = MATERIALS[airMaterial] || MATERIALS.gas;
    body.atmosphere = { mass: massOfAir, material: airMaterial, molarMass: mat.molarMass, thickness: null };
    const g = surfaceGravity(body.mass, body.radius);
    const pressure = (body.mass ? (SI.G * body.mass * massOfAir) / (4 * Math.PI * body.radius ** 4) : 0) || 0;
    const H = scaleHeight(body.temperature, mat.molarMass, g);
    body.atmosphere.pressure = pressure;
    body.atmosphere.scaleHeight = H;
    body.atmosphere.boilingPoint = boilingPoint(pressure);
    body.atmosphere.retention = atmosphereRetention({
      mass: body.mass,
      radius: body.radius,
      molarMass: mat.molarMass,
      temperature: body.temperature,
    });
    this.charge({ mass: massOfAir, temperature: body.temperature, name: { material: airMaterial, kind: 'atmosphere' } });
    return body.atmosphere;
  }

  /**
   * Push, never set. Momentum is exchanged with something you throw: the
   * propellant leaves with -p and the target receives +p, both computed, so the
   * universe's total momentum is untouched. This is the only way to change a
   * created thing's motion, and it is exactly how a real spacecraft works.
   */
  shove(target, direction, energyJoules, slugMass = 0.01) {
    const dir = V.of(direction).norm();
    // The propellant carries -p, so the pair's total momentum is what it was
    // before; the contact solver then apportions it. Nothing is assigned.
    const p = Math.sqrt(2 * Math.max(0, energyJoules) * slugMass);
    const slug = makeBody({
      position: target.position.sub(dir.scale(target.radius * 1.02)),
      velocity: dir.scale(p / slugMass),
      mass: slugMass,
      radius: target.radius * 0.01 || 0.02,
      kind: 'propellant',
      restitution: 0,
    });
    this.world.add(slug);
    this.world.ledger.trackMechanical(0.5 * slugMass * (p / slugMass) ** 2);
    this.charge({ mass: slugMass, temperature: 300, name: { material: 'gas', kind: 'propellant' } });
    this.log.push({ t: this.world.time, op: 'shove', id: target.id, name: target.name, momentum: p, energy: energyJoules });
    this.world.note('shove', `${target.name} +${(p / target.mass).toExponential(2)} m/s`);
    return { propellant: slug, momentum: p, dv: p / target.mass };
  }

  /** The same exchange, but aimed and immediate: used by the console. */
  collide(target, other) {
    const hit = resolvePair(target, other, target.position.sub(other.position));
    if (!hit) return null;
    Object.assign(target, hit.a);
    Object.assign(other, hit.b);
    return hit;
  }

  /**
   * Erase. Not deletion: the mass-energy has to *go* somewhere, so it is
   * recorded as an explicit outflow in the log. A silent delete would be the one
   * way to break the ledger, so the code will not do it.
   */
  erase(id) {
    const b = this.bodies.get(id);
    if (!b) throw new Error(`nothing with id ${id} exists in this universe`);
    const rest = b.mass * SI.c * SI.c;
    const thermal = b.mass * (b.cp || 0) * Math.max(0, b.temperature - SPEC.ambientT);
    this.log.push({ t: this.world.time, op: 'erase', id, name: b.name, returnedJoules: rest + thermal });
    this.world.note('erase', b.name);
    this.world.remove(b);
    this.bodies.delete(id);
    return { rest, thermal };
  }

  /** Refuse mutation. Present so the answer is a clean error, not a surprise. */
  mutate() {
    const err = new Error('a created thing is governed by the laws, not by its creator. Interact physically, or make something new beside it.');
    err.code = 'NOT_YOURS_ANY_MORE';
    throw err;
  }

  /** The universe's own biography: the only clock a void can read. */
  history() {
    return this.log;
  }

  /**
   * Per-frame evolution of what was created. Radiation is the only thing that
   * happens spontaneously in an empty universe, and it always cools the emitter
   * — unless fusion is paying for it. This is where a star's lifetime stops
   * being a number in a comment and becomes a countdown.
   */
  evolve(dt) {
    let radiated = 0;
    for (const b of this.bodies.values()) {
      // Net exchange, so a body colder than the void warms up instead of being
      // pinned at absolute zero by a one-sided law.
      const L = netLuminosity(b.radius, b.temperature, SPEC.ambientT, b.emissivity);
      if (Math.abs(L) < 1e-12) { b.luminosity = 0; continue; }
      let net = L;
      let fused = 0;
      if (b.fusion) {
        // A main-sequence star replaces its radiated loss exactly, until its
        // fuel allowance (10% of m·c², at L watts) runs out.
        const budget = 0.1 * b.mass * SI.c * SI.c;
        if ((b.fused ?? 0) < budget) {
          fused = L;
          b.fused = (b.fused ?? 0) + L * dt;
          net = 0;
        } else {
          b.fusion = false;
          this.world.note('fuel-out', b.name);
        }
      }
      const Q = Math.max(0, net - fused) * dt; // >0: the body is losing
      const Qsign = net > 0 ? 1 : -1; // -1: the void is warming it
      const heat = (Qsign < 0 ? Math.abs(net) * dt : Q) || 0;
      if (heat > 0 && b.cp) {
        const dT = heat / Math.max(1e-9, b.mass * b.cp);
        if (Qsign > 0) b.temperature = Math.max(SPEC.ambientT, b.temperature - dT);
        else b.temperature = Math.min(SPEC.ambientT, b.temperature + dT);
        b.color = blackbodyColor(b.temperature);
        // Entropy on BOTH sides. dS_body = Q/T_body and the bath takes -Q/T_bath;
        // the sum is >= 0 for any pair of temperatures, which is the second law
        // as a checkable inequality rather than a caption.
        const Tb = Math.max(1e-3, b.temperature);
        const Tenv = Math.max(1e-3, SPEC.ambientT);
        const dS = (Qsign > 0 ? heat / Tb : -heat / Tb) + (Qsign > 0 ? -heat / Tenv : heat / Tenv);
        this.world.ledger.trackRadiation(Qsign > 0 ? heat : 0);
        this.world.ledger.entropy += dS;
        if (dS < 0) this.world.ledger.entropyDecreases++;
        radiated += Qsign > 0 ? heat : -heat;
      }
      b.luminosity = L;
    }
    // Collapse: a gas cloud that has no pressure support turns into a star on
    // the free-fall clock. No extra physics invented — the timer is the result.
    for (const b of this.bodies.values()) {
      if (!b.collapse) continue;
      const tff = freefallTime((MATERIALS[b.material] || MATERIALS.h2).density);
      b.freefallTime = tff;
      b.collapseAge = (b.collapseAge || 0) + dt;
      b.collapseProgress = Math.min(1, b.collapseAge / tff);
      if (b.collapseProgress >= 1 && !b.fusion) {
        b.fusion = true;
        b.mainSequence = true;
        b.temperature = 5772 * (b.mass / SUN.mass) ** 0.5;
        b.radius = starRadius(b.mass);
        b.material = 'plasma';
        b.color = blackbodyColor(b.temperature);
        b.collapse = false;
        this.world.note('ignition', b.name);
      }
    }
    return radiated;
  }
}

// ---------------------------------------------------------------------------
// A small declarative language, so the universe can be typed.
//   create star name sol at 0 0 0
//   create earthlike name terr at 1.496e11 0 0 orbit sol
//   create cloud mass 4e30 at -2e11 0 0
//   make 12 stone sphere radius 40 around sol
//   make islands                     <- the previous world, now a macro
// ---------------------------------------------------------------------------

const num = (t) => Number(t);

export function parseCommand(line, ctx = {}) {
  const words = line.trim().split(/\s+/).filter(Boolean);
  if (!words.length) return { op: 'noop' };
  const [op, ...rest] = words;
  const args = {};
  const positional = [];
  for (let i = 0; i < rest.length; i++) {
    const w = rest[i];
    if (w === 'at' || w === 'with' || w === 'from') {
      args[w] = { x: num(rest[i + 1]), y: num(rest[i + 2]), z: num(rest[i + 3]) };
      i += 3;
    } else if (w === 'orbit') {
      args.orbit = rest[i + 1];
      i += 1;
    } else if (w === 'name') {
      args.name = rest[i + 1];
      i += 1;
    } else if (/^[a-zA-Z]+$/.test(w) && i + 1 < rest.length && /^[-+.\deE]+$/.test(rest[i + 1]) && !/^\d/.test(w)) {
      args[w] = num(rest[i + 1]);
      i += 1;
    } else positional.push(w);
  }
  return { op, args, positional };
}

/**
 * Turn a parsed line into a concrete creation, resolving `orbit <name>` into a
 * real circular orbit — the difference between "a planet" and "a planet that is
 * still there in an hour". Velocity magnitude comes from v = sqrt(GM/a) and the
 * direction is perpendicular to the radius vector, so the result is a solution
 * to the same equations the simulation integrates.
 */
export function resolve(parsed, gen, bodiesByName, ctx = {}) {
  const { args, positional } = parsed;
  const kind = positional[0] || 'stone';
  // A creation with no explicit position goes where the creator is looking, not
  // to the origin — which is how `create star` first shipped: it materialised a
  // 2e30 kg star on top of the player and fell straight through it.
  const position = args.at ?? ctx.at ?? new V(0, 0, 0);
  const input = { ...args, kind, position };
  delete input.at;
  // `orbit` is passed through and resolved inside create(), so there is exactly
  // one implementation of "put this in a circular orbit" to get wrong.
  input.orbit = args.orbit;
  return gen.create(input);
}

// ---------------------------------------------------------------------------
// Ground, defined as whatever exists
// ---------------------------------------------------------------------------

/**
 * The void has no floor, so `landSurface` is pointed here: the nearest created
 * surface, signed against its radius. Two consequences worth naming out loud —
 * you can stand on something you made as soon as it is massive enough, and if it
 * is not, your own footstep is a launch (see `stance` in derive()). Ground is
 * earned by mass, never authored.
 */
export function makeSurfaceQuery(gen) {
  return (p) => {
    let best = null;
    for (const b of gen.bodies.values()) {
      if (b.mass < 1e6) continue; // a stone is not a floor; a moon is
      const d = p.dist(b.position) - b.radius;
      if (!best || d < best.sd) {
        const outward = p.sub(b.position);
        const n = d > 0 ? outward.norm() : outward.scale(-1).norm();
        best = { sd: d, n, body: b };
      }
    }
    if (!best) return { signedDistance: Infinity, normal: new V(0, 1, 0), ground: null, body: null };
    return {
      signedDistance: best.sd,
      normal: best.n,
      // kept y-relative so the existing controller maths transfers unchanged
      ground: p.y - Math.max(0, best.sd) * best.n.y,
      body: best.body,
    };
  };
}

/** A void: nothing declared, nothing to stand on, nothing to measure time with. */
export function voidSpec() {
  return { mode: 'void', ground: null, islands: [], seaLevel: null, gravity: 0, spin: 0, ambientT: 2.725, surfaceQuery: null };
}

// ---------------------------------------------------------------------------
// The only lawful self-modification: a rocket
// ---------------------------------------------------------------------------

/**
 * You may not edit a created thing's velocity. You may, however, throw part of
 * yourself — which is the one way a real spacecraft changes its own motion, and
 * the reason this is legal while `mutate()` is not: the reaction mass goes
 * somewhere, so the universe's total momentum and total mass are both untouched.
 *
 * Returns the spent propellant as a body, moving backwards at the exhaust speed.
 * A test asserts the momentum bookkeeping to 1e-12, so "lawful" here is not an
 * adjective; it is a checked inequality.
 */
export function thrust(body, direction, { exhaustSpeed = 2500, propellant = 0.05, gen = null } = {}) {
  const dir = V.of(direction).norm();
  const mp = Math.min(Math.max(0, propellant), body.mass * 0.5);
  if (mp <= 0) return null;
  const M0 = body.mass;
  const M1 = M0 - mp;
  const p0 = body.velocity.scale(M0);
  // Tsiolkovsky in the limit of an impulsive burn: dV = ve · ln(M0/M1)
  const dv = dir.scale(exhaustSpeed * Math.log(M0 / M1));
  body.mass = M1;
  body.velocity = body.velocity.add(dv);
  const spent = makeBody({
    position: body.position.sub(dir.scale(body.radius + 0.05)),
    velocity: p0.sub(body.velocity.scale(M1)).scale(1 / mp), // exact momentum balance
    mass: mp,
    radius: Math.cbrt((3 * mp) / (4 * Math.PI * MATERIALS.gas.density)),
    kind: 'exhaust',
    temperature: 320,
    restitution: 0,
  });
  spent.life = 12;
  if (gen) {
    gen.world.add(spent);
    gen.log.push({ t: gen.world.time, op: 'thrust', id: body.id ?? null, dv: dv.mag(), propellant: mp, exhaustSpeed });
    gen.world.note('thrust', `Δv ${dv.mag().toFixed(3)} m/s`);
  }
  return { spent, dv: dv.mag(), massRatio: M0 / M1, propellant: mp };
}
