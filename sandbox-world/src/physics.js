/**
 * physics.js — the law kernel.
 *
 * Pure arithmetic. No DOM, no three.js, no I/O, no globals it mutates.
 * Everything the world does that a human can see is derived from this file,
 * which is why the same code can be unit-tested head under `node` and
 * imported by a browser unchanged.
 *
 * The design rule for the whole project:
 *
 *   FANTASY IS CONTENT. THE LAWS ARE CONTRACTS.
 *
 * Anything impossible (floating islands, kinetic lances, two moons) is
 * allowed to exist, but never allowed to be free. Every joule spent by a
 * spell has to be subtracted from somewhere, and every impulse has an
 * equal and opposite impulse attached to it.
 */

// ---------------------------------------------------------------------------
// Constants. SI units throughout: metres, kilograms, seconds, joules.
// ---------------------------------------------------------------------------

export const SI = Object.freeze({
  G: 6.6743e-11, // gravitational constant            m^3 kg^-1 s^-2
  g0: 9.80665, // standard gravity                  m s^-2
  c: 299792458, // speed of light in vacuum          m s^-1
  sigma: 5.670374419e-8, // Stefan-Boltzmann constant           W m^-2 K^-4
  b: 2.897771955e-3, // Wien displacement constant        m K
  water: 1000, // density of water                  kg m^-3
  air: 1.225, // density of air at sea level       kg m^-3
  meltIce: 333500, // latent heat of fusion of ice      J kg^-1
  heatWater: 4184, // specific heat of liquid water     J kg^-1 K^-1
  k: 1.380649e-23, // Boltzmann constant               J K^-1
  NA: 6.02214076e23, // Avogadro constant              mol^-1
  Rsun: 6.957e8, // solar radius                        m
  Msun: 1.98892e30, // solar mass                        kg
  Lsun: 3.828e26, // solar luminosity                   W
  AU: 1.495978707e11, // astronomical unit              m
});

// ---------------------------------------------------------------------------
// Vec3 — minimal immutable 3-vector. Deliberately NOT three.js's Vector3, so
// this kernel stays engine-agnostic and testable in isolation.
// ---------------------------------------------------------------------------

export class V {
  constructor(x = 0, y = 0, z = 0) {
    this.x = x;
    this.y = y;
    this.z = z;
  }
  static of(a) {
    return new V(a.x, a.y, a.z);
  }
  add(b) {
    return new V(this.x + b.x, this.y + b.y, this.z + b.z);
  }
  sub(b) {
    return new V(this.x - b.x, this.y - b.y, this.z - b.z);
  }
  scale(s) {
    return new V(this.x * s, this.y * s, this.z * s);
  }
  dot(b) {
    return this.x * b.x + this.y * b.y + this.z * b.z;
  }
  cross(b) {
    return new V(
      this.y * b.z - this.z * b.y,
      this.z * b.x - this.x * b.z,
      this.x * b.y - this.y * b.x,
    );
  }
  mag2() {
    return this.dot(this);
  }
  mag() {
    return Math.sqrt(this.mag2());
  }
  dist(b) {
    return this.sub(b).mag();
  }
  norm() {
    const m = this.mag();
    return m > 0 ? this.scale(1 / m) : new V(0, 0, 0);
  }
  /** Reflect about a unit normal (bounce geometry, not physics response). */
  reflect(n) {
    return this.sub(n.scale(2 * this.dot(n)));
  }
  toArray() {
    return [this.x, this.y, this.z];
  }
  equals(b, eps = 1e-12) {
    return this.sub(b).mag() <= eps;
  }
}

export const ZERO = new V(0, 0, 0);

// ---------------------------------------------------------------------------
// 1. Gravity — Newtonian, and it obeys the equivalence principle by
//    construction: acceleration is independent of the falling mass, because
//    mass never appears in the expression the integrator uses.
// ---------------------------------------------------------------------------

/** Point-mass field: a = -G M r_hat / r^2 (m s^-2). */
export function gravitationalAcceleration(position, source, mass, G = SI.G) {
  const r = position.sub(source);
  const d2 = r.mag2();
  if (d2 <= 0) return ZERO;
  return r.norm().scale((-G * mass) / d2);
}

/**
 * A `Field` is the local world gravity model: a uniform ground term plus any
 * number of celestial bodies. The moons are not decoration — if they are in
 * the field, they measurably tug you, and they produce tides on the water.
 */
export class Field {
  constructor(g = SI.g0) {
    this.g = g;
    this.bodies = [];
  }
  addBody({ name, position, mass }) {
    this.bodies.push({ name, position: V.of(position), mass });
    return this;
  }
  /** Acceleration at a point: down, plus every body's pull. */
  accelerationAt(position) {
    let a = new V(0, -this.g, 0);
    for (const b of this.bodies) a = a.add(gravitationalAcceleration(position, b.position, b.mass));
    return a;
  }

  /** Tidal acceleration across a baseline `offset` (differential gravity). */
  tidalAt(position, offset) {
    const near = this.accelerationAt(position);
    const far = this.accelerationAt(position.add(offset));
    return far.sub(near);
  }
}

/**
 * Gravitational potential (J/kg) for a set of point masses. Used for the
 * energy ledger, which is how we prove the world is not inventing energy.
 */
export function potentialPerKg(position, bodies, G = SI.G) {
  let phi = 0;
  for (const b of bodies) {
    const d = position.dist(b.position);
    if (d > 0) phi -= (G * b.mass) / d;
  }
  return phi;
}

// ---------------------------------------------------------------------------
// 2. Kinematics + drag — semi-implicit (symplectic) Euler at a FIXED step.
//    Fixed dt is not a performance choice, it is a correctness choice: a
//    variable timestep makes the world non-reproducible and quietly breaks
//    conservation, because the integration error would then depend on frame
//    rate. Determinism is asserted in the test suite.
// ---------------------------------------------------------------------------

export const FIXED_DT = 1 / 240; // 240 Hz physics, decoupled from render rate

/** Quadratic drag: F = -0.5 rho Cd A |v| v. Terminal velocity falls out of
 *  this for free; we never hard-code "the arrow slows down". */
export function dragForce(velocity, { rho = SI.air, cd = 0.47, area = 0.005 } = {}) {
  const speed = velocity.mag();
  if (speed === 0) return ZERO;
  return velocity.norm().scale(-0.5 * rho * cd * area * speed * speed);
}

export function integrate(body, force, dt) {
  const a = force.scale(1 / body.mass);
  const velocity = body.velocity.add(a.scale(dt));
  const position = body.position.add(velocity.scale(dt));
  return { ...body, velocity, position, age: body.age + dt };
}

/** One physics substep for a body under a gravity field with optional drag. */
export function stepBody(body, field, dt, { drag = null } = {}) {
  const force = field
    .accelerationAt(body.position)
    .scale(body.mass)
    .add(drag ? dragForce(body.velocity, drag) : ZERO);
  return integrate(body, force, dt);
}

export function makeBody({
  position,
  velocity = ZERO,
  mass = 1,
  radius = 0.5,
  restitution = 1,
  fixed = false,
  kind = 'body',
  charge = 0,
}) {
  return {
    kind,
    mass,
    radius,
    restitution,
    fixed,
    charge,
    position: V.of(position),
    velocity: V.of(velocity),
    angularVelocity: ZERO,
    age: 0,
    // Fantasy bookkeeping lives next to the mechanics, never instead of it.
    heat: 0,
  };
}

export const kinetic = (b) => 0.5 * b.mass * b.velocity.mag2();
export const momentum = (b) => b.velocity.scale(b.mass);

// ---------------------------------------------------------------------------
// 3. Contacts. Impulse-based resolution in the collision normal direction.
//    Momentum is exact to floating point; energy may only go DOWN, and any
//    deficit is booked as heat rather than deleted. That booking is the
//    difference between "a physics engine" and "a world with laws".
// ---------------------------------------------------------------------------

export function resolvePair(a, b, normal) {
  const n = normal.norm();
  const relVel = a.velocity.sub(b.velocity);
  const closing = relVel.dot(n);
  if (closing >= 0) return null; // separating already
  const e = Math.min(a.restitution, b.restitution);
  const invA = a.fixed || a.mass <= 0 ? 0 : 1 / a.mass;
  const invB = b.fixed || b.mass <= 0 ? 0 : 1 / b.mass;
  const invSum = invA + invB;
  if (invSum === 0) return null;

  const j = (-(1 + e) * closing) / invSum;
  const impulse = n.scale(j);
  const va = a.velocity.add(impulse.scale(invA));
  const vb = b.velocity.sub(impulse.scale(invB));

  // KE lost in the normal direction becomes heat in both bodies. Infinite-mass
  // walls are excluded from the accounting: they absorb momentum but carry no
  // energy, which is exactly what an immovable object means.
  const keOf = (body, v) => (body.fixed || !Number.isFinite(body.mass) ? 0 : 0.5 * body.mass * v.mag2());
  const before = keOf(a, a.velocity) + keOf(b, b.velocity);
  const after = keOf(a, va) + keOf(b, vb);
  const lost = Math.max(0, before - after);
  const shareA = invSum > 0 ? invA / invSum : 0;

  return {
    a: { ...a, velocity: va, heat: (a.heat || 0) + lost * shareA },
    b: { ...b, velocity: vb, heat: (b.heat || 0) + lost * (1 - shareA) },
    impulse: j,
    dissipated: lost,
  };
}

export function collideSpheres(a, b) {
  const delta = b.position.sub(a.position);
  const d = delta.mag();
  const overlap = a.radius + b.radius - d;
  if (overlap <= 0) return null;
  const n = d > 0 ? delta.scale(1 / d) : new V(0, 1, 0);
  // positional correction, split by inverse mass so heavy things barely move
  const invA = a.fixed ? 0 : 1 / a.mass;
  const invB = b.fixed ? 0 : 1 / b.mass;
  const sum = invA + invB || 1;
  const push = n.scale(overlap);
  const fixed = {
    a: { ...a, position: a.position.sub(push.scale((invA / sum) * 0.8)) },
    b: { ...b, position: b.position.add(push.scale((invB / sum) * 0.8)) },
  };
  const hit = resolvePair(fixed.a, fixed.b, n.scale(-1));
  if (!hit) return { bodies: [a, b], contact: null, overlap };
  return { bodies: [hit.a, hit.b], contact: hit, overlap };
}

/** Body against an implicit surface f(x)=0 with gradient-derived normal. */
export function collideHalfSpace(body, surface) {
  const { signedDistance, normal } = surface(body.position);
  if (signedDistance >= 0) return { body, contact: null };
  const n = normal.norm();
  const corrected = { ...body, position: body.position.add(n.scale(-signedDistance)) };
  const wall = {
    mass: Infinity,
    fixed: true,
    velocity: ZERO,
    restitution: 1,
    heat: 0,
    position: corrected.position,
  };
  const hit = resolvePair(corrected, wall, n);
  if (!hit) {
    // still separate the bodies so we never sink in
    const vn = corrected.velocity.dot(n);
    if (vn < 0) return { body: { ...corrected, velocity: corrected.velocity.sub(n.scale(vn)) }, contact: null };
    return { body: corrected, contact: null };
  }
  return { body: hit.a, contact: hit };
}

// ---------------------------------------------------------------------------
// 4. Terrain as shared truth.
//
// The renderer and the collision solver both call THIS function. Floating
// islands are pure fantasy, but they are fantasy with a defined surface, so
// you can stand on them and a stone dropped beside them falls into the same
// hole the pixels drew. One source of truth, so they cannot disagree.
// ---------------------------------------------------------------------------

/**
 * SPEC is the *shape of the universe*: what exists at all. It is declared, never
 * assumed. The void is a legal value — no floor, no sea, no downward direction,
 * no ambient temperature worth the name. Everything else in this file reads from
 * here, so "nothing exists" is a single coherent state rather than a pile of
 * special cases scattered through the code.
 */
export const VOID = Object.freeze({
  mode: 'void',
  ground: null, // null: there is no surface to be on. Not a floor at y=-1e9.
  islands: [], //   nothing to stand on, nothing to collide with
  seaLevel: null, // null: there is no water, and therefore no buoyancy
  gravity: 0, //     no mass yet, so no preferred direction: no "down"
  spin: 0, //        nothing rotating, so no Coriolis, no equatorial bulge
  ambientT: 2.725, //  the one thing a void is entitled to: CMB background
  time: 'relational', // time accrues only while something is changing
});

export const SPEC = {
  mode: 'archipelago',
  ground: -4.0,
  islands: [
    { x: 0, z: 0, r: 34, h: 6.0, tilt: 0.0 },
    { x: 92, z: -36, r: 22, h: 15.5, tilt: -0.04 },
    { x: -78, z: 70, r: 18, h: 9.5, tilt: 0.05 },
  ],
  seaLevel: 0.6,
  gravity: SI.g0,
  spin: 7.2722e-5,
  ambientT: 288.15,
  time: 'relational',
};

/** Replace part of the universe's definition. Returns the new SPEC. */
export function setSpec(patch = {}) {
  Object.assign(SPEC, patch);
  if (patch.mode === 'void') Object.assign(SPEC, { ...VOID, ...patch });
  return SPEC;
}

export const isVoid = () => SPEC.mode === 'void';
/** The void is a true null: not a very far floor, not a very low sea. */
export const hasGround = () => SPEC.ground !== null;
export const hasWater = () => SPEC.seaLevel !== null;

/** Live alias of the island list. Same array object as SPEC.islands, by design:
 *  one list, so the mesh builder and the collision solver cannot drift apart. */
export const ISLANDS = SPEC.islands;

/** Height of land at x,z (metres above datum). 0 or below means open water. */
export function terrainHeight(x, z) {
  if (!hasGround()) return null; //  nothing exists here — not even a floor
  let h = SPEC.ground;
  for (const i of SPEC.islands) {
    const dx = x - i.x;
    const dz = z - i.z;
    const d = Math.hypot(dx, dz);
    if (d >= i.r) continue;
    const t = d / i.r;
    // smooth dome with an erosion-ish rim; analytic, so the normal is exact
    const dome = Math.cos(t * Math.PI * 0.5);
    const rim = 0.35 * Math.sin(t * 9.0) * (1 - t) * (1 - t);
    const ridge = 1.6 * Math.sin(x * 0.09) * Math.cos(z * 0.11);
    const surface = i.h * (dome * dome) + rim * i.h + ridge * (1 - t) + (i.tilt * dx);
    h = Math.max(h, surface);
  }
  return h;
}

export const SEA_LEVEL = 0.6;

/**
 * Exact analytic surface query used by collision. In the void there is no
 * surface, so the signed distance is a genuine Infinity: callers cannot
 * "miss" a floor that was never created, and no mesh can be built on it.
 */
/**
 * Injected by genesis when the universe has no floor: "ground" then means
 * whatever surface exists, i.e. the things that were created. A created planet
 * is terrain because gravity and contact say so, not because a heightfield was
 * authored. Null in a void with nothing in it, which is the honest answer.
 */
export function setSurfaceQuery(fn) {
  SPEC.surfaceQuery = fn || null;
}

export function landSurface(p) {
  if (SPEC.surfaceQuery) return SPEC.surfaceQuery(p);
  if (!hasGround()) return { signedDistance: Infinity, normal: new V(0, 1, 0), ground: null };
  const h = terrainHeight(p.x, p.z);
  const e = 0.5;
  const hx = (terrainHeight(p.x + e, p.z) - terrainHeight(p.x - e, p.z)) / (2 * e);
  const hz = (terrainHeight(p.x, p.z + e) - terrainHeight(p.x, p.z - e)) / (2 * e);
  const n = new V(-hx, 1, -hz).norm();
  const sd = (p.y - h) * n.y;
  return { signedDistance: sd, normal: n, ground: h };
}

export function waterSurface(p, t, moons = []) {
  if (!hasWater()) return { height: null, normal: null };
  let swell = 0;
  for (const m of moons) {
    const dir = Math.cos((p.x - m.position.x) * 0.004 + (p.z - m.position.z) * 0.004 + t * 0.05);
    const strength = Math.min(1.2, (SI.G * m.mass) / Math.max(1e18, m.position.mag2() * 4e6));
    swell += 0.55 * strength * dir;
  }
  const chop = 0.11 * Math.sin(p.x * 0.35 + t * 1.3) + 0.08 * Math.cos(p.z * 0.42 - t * 1.1);
  const h = SPEC.seaLevel + swell + chop;
  return {
    height: h,
    normal: new V(-0.02 * Math.cos(p.x * 0.35 + t * 1.3), 1, 0.02 * Math.sin(p.z * 0.42 - t * 1.1)).norm(),
  };
}

// ---------------------------------------------------------------------------
// 5. Buoyancy. Archimedes, not a tween. A log floats because it displaces its
//    own weight; an anchor sinks because it cannot.
// ---------------------------------------------------------------------------

export function submergedFraction(radius, bodyY, waterY) {
  const r = radius;
  const bottom = bodyY - r;
  const top = bodyY + r;
  if (waterY <= bottom) return 0;
  if (waterY >= top) return 1;
  const hh = waterY - bottom; // 0..2r
  // spherical cap volume fraction
  const cap = (Math.PI * hh * hh * (3 * r - hh)) / 3;
  return Math.min(1, cap / ((4 / 3) * Math.PI * r * r * r));
}

export function buoyancy(body, waterY, densityOfFluid = SI.water) {
  const f = submergedFraction(body.radius, body.position.y, waterY);
  if (f === 0) return ZERO;
  const volume = (4 / 3) * Math.PI * body.radius ** 3;
  const displaced = densityOfFluid * volume * f;

  // Water resistance = linear (viscous / added-mass) + quadratic (form drag).
  // Without these, floating bodies bob forever, which no ocean has ever done.
  const kLin = 3 * densityOfFluid * volume * f;
  const kQuad = 0.5 * densityOfFluid * 0.5 * Math.PI * body.radius ** 2 * f;
  const speed = body.velocity.mag();
  const resist = body.velocity
    .scale(-kLin)
    .add(speed > 0 ? body.velocity.norm().scale(-kQuad * speed) : ZERO);

  return new V(0, displaced * SI.g0, 0).add(resist);
}

// ---------------------------------------------------------------------------
// 6. Optics. The sky, the water, glass and torchlight are all computed from
//    these, so "magic light" is still bound by the inverse-square law.
// ---------------------------------------------------------------------------

/** Snell. Returns the refracted unit direction, or null when totally
 *  internally reflected — the ray genuinely cannot escape the water. */
export function refract(incident, normal, etaRatio) {
  const i = incident.norm();
  const n = normal.norm();
  const cosI = -n.dot(i);
  const sinT2 = etaRatio * etaRatio * (1 - cosI * cosI);
  if (sinT2 > 1) return null; // TIR
  return i.scale(etaRatio).add(n.scale(etaRatio * cosI - Math.sqrt(1 - sinT2))).norm();
}

export function criticalAngle(nDense, nRare) {
  return Math.asin(Math.min(1, nRare / nDense));
}

/** Fresnel reflectance at normal incidence. */
export function fresnel(n1, n2) {
  const r = (n1 - n2) / (n1 + n2);
  return r * r;
}

/** Irradiance from an isotropic point source: I / (4 pi r^2). */
export function irradiance(power, distance) {
  return power / (4 * Math.PI * Math.max(distance * distance, 1e-9));
}

/**
 * Blackbody temperature -> sRGB, via Planck locus and Helland's piecewise fit.
 * The renderer asks this instead of being told "stars are yellow", so a cooling
 * object drifts red on screen for the same reason its Wien peak moves.
 */
export function blackbodyColor(T) {
  const t = Math.max(0, Math.min(40000, Number(T) || 0));
  if (t <= 0) return 0x000000;
  const temp = t / 100;
  let r, g, b;
  if (temp <= 66) {
    r = 255;
    g = 99.4708025861 * Math.log(temp) - 161.1195681661;
    b = temp <= 19 ? 0 : 138.5177312231 * Math.log(temp - 10) - 305.0447927307;
  } else {
    r = 329.698727446 * (temp - 60) ** -0.1332047592;
    g = 288.1221695283 * (temp - 60) ** -0.0755148492;
    b = 255;
  }
  const cl = (x) => Math.max(0, Math.min(255, x)) / 255;
  const gam = (x) => (x > 0.0031308 ? 1.055 * x ** (1 / 2.4) - 0.055 : 12.92 * x);
  return ((gam(cl(r)) * 255) << 16) | ((gam(cl(g)) * 255) << 8) | (gam(cl(b)) * 255);
}

/**
 * Net radiative power of a sphere against its environment. Absolute rather
 * than gross matters here: a body cooler than the void absorbs, warms up, and
 * is therefore *changing* — and a body exactly at background temperature is in
 * equilibrium, radiating and absorbing the same amount. That last case is what
 * makes the void genuinely timeless, so the engine must compute it honestly.
 */
export function netLuminosity(radius, T, Tenv = SPEC.ambientT, emissivity = 1) {
  const area = 4 * Math.PI * radius * radius;
  const t = Math.max(0, Number(T) || 0);
  const e = Math.max(0, Number(Tenv) || 0);
  return area * Math.max(0, emissivity ?? 1) * SI.sigma * (t ** 4 - e ** 4);
}

/** Wien peak wavelength (m) and Stefan-Boltzmann exitance (W/m^2). */
export const wienPeak = (T) => SI.b / T;
export const exitance = (T, emissivity = 1) => emissivity * SI.sigma * T ** 4;

/** Classical Doppler shift for a source and observer moving along the
 *  source->observer axis, in a medium of speed `v`. */
export function observedFrequency(f0, v, observerSpeedToward, sourceSpeedToward) {
  const num = v + observerSpeedToward;
  const den = v - sourceSpeedToward;
  return (f0 * num) / Math.max(1e-6, den);
}

// ---------------------------------------------------------------------------
// 7. Thermodynamics, for things that burn, freeze, or glow.
// ---------------------------------------------------------------------------

export function heatToTemperatureDelta(qJoules, mass, specificHeat = SI.heatWater) {
  return qJoules / Math.max(1e-9, mass * specificHeat);
}

export function energyToMeltIce(qJoules) {
  return qJoules / SI.meltIce; // kg
}

/** Newtonian cooling toward ambient. */
export function cool(T, ambient, k, dt) {
  return ambient + (T - ambient) * Math.exp(-k * dt);
}

// ---------------------------------------------------------------------------
// 8. The ledger. Every transaction in the world goes through here and can be
//    audited: energy is tracked, never assumed. If `audit()` ever reports a
//    creation of energy the world is broken, and the test suite fails.
// ---------------------------------------------------------------------------

export class Ledger {
  constructor(label = 'world') {
    this.label = label;
    this.stored = 0; // joules in batteries/atmosphere/whatever
    this.mechanical = 0;
    this.thermal = 0;
    this.radiated = 0;
    this.entries = [];
    // Entropy is NOT a fifth energy bucket — different units, so it must never
    // be added to total(). It is the one number in this universe allowed to
    // rise for free, and it is the only direction time is known to have.
    this.entropy = 0;
    this.entropyDecreases = 0;
  }
  credit(source, joules, note = '') {
    if (!(joules > 0)) throw new Error(`${this.label}: refusing non-positive credit of ${joules} from ${source}`);
    this.stored += joules;
    this.entries.push({ t: 'credit', source, joules, note });
    return joules;
  }
  spend(source, joules, note = '') {
    if (joules > this.stored + 1e-9) {
      const err = new Error(`${this.label}: ${source} tried to spend ${joules.toFixed(1)} J with only ${this.stored.toFixed(1)} J stored`);
      err.code = 'NO_FREE_ENERGY';
      throw err;
    }
    this.stored -= joules;
    this.entries.push({ t: 'spend', source, joules, note });
    return joules;
  }
  trackMechanical(j) {
    this.mechanical += j;
  }
  /**
   * Dissipation books entropy at the temperature it happened at. A cold universe
   * is punished far harder for the same joule: dS = Q/T, so waste heat in the void
   * (2.7 K) costs ~100x the entropy it would cost at room temperature. That is not
   * flavour text, it is the reason an exothermic act in deep space is a *visible*
   * event and the same act in air is not.
   */
  trackHeat(j, T = SPEC.ambientT) {
    this.thermal += j;
    const dS = j / Math.max(1e-3, T);
    if (dS < 0) this.entropyDecreases++;
    this.entropy += dS;
  }
  /** Radiation leaving a hot body at T into a cold universe: same rule. */
  trackEntropy(j, T) {
    const dS = j / Math.max(1e-3, T);
    if (dS < 0) this.entropyDecreases++;
    this.entropy += dS;
  }
  /** Energy that left the store as light. The caller has already spent it. */
  trackRadiation(j) {
    this.radiated += j;
  }
  /**
   * Double-entry helper: move joules OUT of `stored` and INTO a destination
   * bucket in one operation, so the total can never silently change. A spell
   * that "spends" without naming a destination is the exact shape of a
   * perpetual-motion bug, which is why every caster call routes through here.
   */
  transfer(joules, destination, note = '') {
    if (joules <= 0) return 0;
    this.spend(destination, joules, note);
    if (destination === 'mechanical') this.mechanical += joules;
    else if (destination === 'radiation') this.radiated += joules;
    else this.thermal += joules;
    return joules;
  }
  total() {
    return this.stored + this.mechanical + this.thermal + this.radiated;
  }
  /** Returns { ok, drift } where drift is energy created or destroyed. */
  audit(initialTotal = 0) {
    const drift = this.total() - initialTotal;
    return { ok: Math.abs(drift) < 1e-6 * Math.max(1, Math.abs(initialTotal)), drift };
  }
}

// ---------------------------------------------------------------------------
// 9. The world: owns bodies, the gravity field, and the fixed-step loop.
// ---------------------------------------------------------------------------

export class World {
  constructor({ gravity = SPEC.gravity, dt = FIXED_DT, nBody = false } = {}) {
    this.nBody = nBody; // true in a universe: everything with mass is a source
    this.field = new Field(gravity);
    this.bodies = [];
    this.emitters = []; // anything that radiates: a change, so it feeds the clock
    this.dt = dt;
    this.time = 0;
    this.accumulator = 0;
    this.frozenFrames = 0;
    this.events = []; // the universe's history; see timeline()
    this.ledger = new Ledger('arcane');
    this.contacts = 0;
    this.waterY = hasWater() ? SPEC.seaLevel : -1e9;
  }
  /**
   * Relational time. Leibniz: time is the order of successive things, so a
   * universe with no change has no duration to measure — not "a clock running
   * in an empty room", but literally no elapsed time. `activity` is the total
   * power available to produce change: work being done, forces waiting to do
   * it, light leaving something. Zero means the state is a fixed point, and
   * advancing it would be theatre.
   */
  activity() {
    let a = 0;
    for (const b of this.bodies) {
      if (b.fixed) continue;
      let accel = this.field.accelerationAt(b.position);
      if (this.nBody) {
        for (const o of this.bodies) {
          if (o === b || o.fixed || o.mass <= 0) continue;
          accel = accel.add(gravitationalAcceleration(b.position, o.position, o.mass));
        }
      }
      const F = accel.scale(b.mass);
      a += F.mag() * (1 + b.velocity.mag()); // F·v is power; F alone is potential for change
      if (b.heat) a += b.heat;
    }
    // A radiating body is a change in flight, so it keeps the clock running.
    // Net, not gross: equilibrium against the background is not a change.
    for (const b of this.bodies) if (Number.isFinite(b.luminosity)) a += Math.abs(b.luminosity);
    for (const e of this.emitters) a += e.watts || 0;
    return a;
  }
  isEvolving() {
    const a = this.activity();
    if (!Number.isFinite(a)) return false; // a NaN universe cannot be said to change
    return this.bodies.length > 0 && a > 1e-12;
  }
  add(body) {
    this.bodies.push(body);
    return body;
  }
  remove(body) {
    const i = this.bodies.indexOf(body);
    if (i >= 0) this.bodies.splice(i, 1);
  }
  /** Advance by an arbitrary frame time using whole fixed substeps. */
  advance(elapsed) {
    if (SPEC.time === 'relational' && !this.isEvolving()) {
      // Nothing can happen, so nothing has happened. The clock does not run.
      this.accumulator = 0;
      this.frozenFrames++;
      return 0;
    }
    this.accumulator += elapsed;
    let steps = 0;
    while (this.accumulator >= this.dt && steps < 60) {
      this.step();
      this.accumulator -= this.dt;
      steps++;
    }
    return steps;
  }
  step() {
    const bodies = this.bodies;
    // Mutate in place. The renderer keeps a body->mesh map keyed on object
    // identity, and game code holds references across frames; swapping in fresh
    // objects every step silently strands every one of them. (A soak test
    // caught exactly this: meshes stopped moving, positions stopped matching.)
    for (const b of bodies) {
      if (b.fixed) continue;
      let accel = this.field.accelerationAt(b.position);
      if (this.nBody) {
        for (const o of bodies) {
          if (o === b || o.fixed || o.mass <= 0) continue;
          accel = accel.add(gravitationalAcceleration(b.position, o.position, o.mass));
        }
      }
      let force = accel.scale(b.mass);
      if (b.aerodynamic) force = force.add(dragForce(b.velocity, b.aerodynamic));
      if (b.position.y - b.radius < this.waterY) {
        force = force.add(buoyancy(b, this.waterY, b.fluidDensity ?? SI.water));
      }
      const a = force.scale(1 / (b.mass || 1));
      b.velocity = b.velocity.add(a.scale(this.dt));
      b.position = b.position.add(b.velocity.scale(this.dt));
      b.age += this.dt;
    }
    for (let i = 0; i < bodies.length; i++) {
      for (let j = i + 1; j < bodies.length; j++) {
        const res = collideSpheres(bodies[i], bodies[j]);
        if (!res) continue;
        Object.assign(bodies[i], res.bodies[0]);
        Object.assign(bodies[j], res.bodies[1]);
        if (res.contact) {
          this.contacts++;
          this.ledger.trackHeat(res.contact.dissipated);
        }
      }
    }
    for (const b of bodies) {
      if (b.fixed) continue;
      if (!hasGround() && !SPEC.surfaceQuery) continue; // no floor exists to hit
      const onLand = landSurface(b.position);
      if (onLand.signedDistance >= 0) continue;
      const r = collideHalfSpace(b, landSurface);
      Object.assign(b, r.body);
      this.contacts++;
      if (r.contact) this.ledger.trackHeat(r.contact.dissipated);
    }
    this.time += this.dt;
  }
  snapshot() {
    return this.bodies.map((b) => [b.position.x, b.position.y, b.position.z, b.velocity.x, b.velocity.y, b.velocity.z]);
  }
  /**
   * The only history a void can have: a list of things that changed. `time` is
   * derived from this, not the other way round.
   */
  note(what, detail = '') {
    this.events.push({ t: this.time, what, detail });
    return this.events.length;
  }
  timeline() {
    return this.events;
  }
}

/** Total mechanical + thermal energy of the world, for the HUD and the tests. */
export function totalEnergy(world) {
  const g = world.field ? world.field.g : SI.g0;
  let ke = 0;
  let pe = 0;
  let heat = 0;
  for (const b of world.bodies) {
    if (b.fixed) continue;
    ke += kinetic(b);
    pe += b.mass * g * b.position.y;
    heat += b.heat || 0;
  }
  return { ke, pe, heat, total: ke + pe + heat };
}

/**
 * Universe-level bookkeeping for the HUD. `entropy` only ever grows: if a build
 * ever reports it going down, something in the code is deleting energy instead of
 * moving it, and tests/void.test.mjs fails on that alone.
 */
export function universeState(world) {
  const E = totalEnergy(world);
  return {
    ...E,
    bodies: world.bodies.length,
    entropy: world.ledger.entropy,
    evolving: world.isEvolving(),
    time: world.time,
    frozenFrames: world.frozenFrames,
  };
}
