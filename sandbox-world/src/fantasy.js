/**
 * fantasy.js — the impossible, priced.
 *
 * This is the file that makes the world a fantasy instead of a physics demo.
 * It contains things that do not exist. It is also the file that refuses to
 * let them be free.
 *
 * Invariants this module maintains:
 *   - A spell is a TRANSDUCER, never a SOURCE. It moves energy from a store
 *     (your stamina, a charged crystal, a thermal gradient) into mechanical
 *     work. `Ledger.spend` throws if you ask for more than you have, so
 *     perpetual motion is not "discouraged", it is unrepresentable.
 *   - Every impulse delivered to a target is delivered back to the caster.
 *     Recoil is not flavour text; it is applied to the caster's body.
 *   - Damage is a function of delivered kinetic energy and of the materials
 *     involved. There is no "10 damage" anywhere in this codebase.
 *   - Anything you make brighter must come out of somewhere, and the
 *     something is heat.
 */

import { V, SI, Ledger, kinetic, dragForce, irradiance, exitance, wienPeak } from './physics.js';

/** Specific energy of the ambient store, J/kg. Mana is a fuel, so it has one. */
export const MANA_SPECIFIC_ENERGY = 4.18e6; // ~ a hydrocarbon, on purpose

export class Caster {
  /**
   * @param {object} o
   * @param {number} o.mass          kg of the caster (recoil needs it)
   * @param {number} o.capacity      J of usable store
   * @param {V}      o.position
   * @param {V}      [o.velocity]
   */
  constructor({ mass = 80, capacity = 4.2e6, position = ZEROISH, velocity = ZEROISH, body = null }) {
    this.mass = mass;
    this.ledger = new Ledger('caster');
    this.ledger.credit('metabolism', capacity, 'usable store at t=0');
    this.capacity = capacity;
    this.position = V.of(position);
    this.velocity = V.of(velocity);
    this.body = body;
    this.efficiency = 0.92; // transducers are lossy; the loss is dumped as heat
    this.castCount = 0;
  }
  get charge() {
    return this.ledger.stored;
  }
  get chargeFraction() {
    return this.charge / this.capacity;
  }

  /**
   * KINETIC LANCE — a collinear impulse, delivered by accelerating a slug of
   * air to hypersonic speed inside a channel. Costs 0.5 m v^2 of the lance
   * plus resistive losses, and pushes the caster backwards with p = m v.
   */
  lance({ aim, slugMass = 0.02, muzzleVelocity = 900, target = null }) {
    const dir = V.of(aim).norm();
    const energy = 0.5 * slugMass * muzzleVelocity * muzzleVelocity;
    const wall = energy / this.efficiency;
    this.ledger.spend('lance', wall, `${(wall / 1000).toFixed(1)} kJ per shot`);
    const waste = wall - energy;
    // double entry: the store's loss is the world's gain, booked by name.
    this.ledger.trackMechanical(energy);
    this.ledger.trackHeat(waste);

    // recoil: momentum conservation applied to the caster, always
    const recoil = dir.scale(-slugMass * muzzleVelocity);
    const dv = recoil.scale(1 / this.mass);
    this.velocity = this.velocity.add(dv);
    if (this.body) this.body.velocity = this.body.velocity.add(dv);
    this.castCount++;

    const projectile = {
      position: this.position.add(dir.scale(0.8)),
      velocity: dir.scale(muzzleVelocity),
      mass: slugMass,
      radius: 0.03,
      restitution: 0.2,
      kind: 'lance',
      heat: waste,
      age: 0,
      fixed: false,
      aerodynamic: { rho: SI.air, cd: 0.15, area: 0.0009 },
      charge: 0,
    };

    let impact = null;
    if (target) {
      // Energy actually delivered is what remains AT the target, not what left
      // the muzzle. Drag is billed before damage. That is the whole point.
      const travel = this.position.dist(target.position);
      const lostToDrag = dragLoss(projectile, travel);
      const delivered = Math.max(0, energy - lostToDrag);
      impact = { delivered, lostToDrag, penetration: delivered / 1.2e6 };
      const j = dir.scale(Math.min(delivered, target.mass * 50) / Math.max(1, muzzleVelocity / 50));
      const dvt = j.scale(1 / target.mass);
      target.velocity = target.velocity.add(dvt);
    }

    return { projectile, recoilVelocity: dv, energy, waste, impact };
  }

  /**
   * LIFT — the classic. Floating islands are why we are here, so the spell
   * that lifts a stone must be the same mechanism the islands use: not
   * "gravity off", but a force that costs energy while it is applied, and
   * stops the instant the concentration breaks.
   */
  lift({ target, acceleration = SI.g0, duration }) {
    const force = SI.g0 * target.mass * (acceleration / SI.g0);
    const energy = force * Math.max(0, duration) * Math.max(0.15, Math.abs(target.velocity.y) + 0.15);
    const wall = energy / this.efficiency;
    const available = this.charge;
    const billed = Math.min(wall, available);
    const frac = wall > 0 ? billed / wall : 0;
    const beforeKE = 0.5 * target.mass * target.velocity.mag2();
    // Whether or not the store can cover the full cast, the impulse actually
    // delivered is proportional to what was paid for. A partial payment buys a
    // partial lift — it does not buy a free one.
    if (billed > 0) this.ledger.spend('lift', billed, `holding ${target.mass} kg for ${duration.toFixed(3)} s`);
    target.velocity = target.velocity.add(new V(0, acceleration * duration * frac, 0));
    const gained = Math.max(0, 0.5 * target.mass * target.velocity.mag2() - beforeKE);
    const mech = Math.min(billed, gained);
    if (mech > 0) this.ledger.trackMechanical(mech);
    if (billed - mech > 0) this.ledger.trackHeat(billed - mech);
    return { ok: frac >= 1, drained: frac < 1, appliedJoules: billed, neededJoules: wall, fraction: frac };
  }

  /**
   * COLD HAND — you cannot delete heat, so a freeze spell is a HEAT PUMP.
   * It moves heat out of the target and dumps it behind you, and the work it
   * must do is bounded by Carnot. Ask it to freeze something already near
   * ambient and it costs almost nothing; ask it to reach deep cold and the
   * bill explodes. That asymmetry is real, and it is the fun part.
   */
  chill({ target, massOfIce = 2, fromT = 293.15, toT = 273.15, freeze = true }) {
    const Tc = toT;
    const Th = fromT;
    const Qc = massOfIce * SI.heatWater * Math.max(0, fromT - toT) + (freeze ? massOfIce * SI.meltIce : 0);
    const cop = Tc / Math.max(1e-6, Th - Tc); // Carnot heat-pump COP
    const work = Qc / Math.max(0.02, cop);
    if (work > this.charge) {
      return { ok: false, drained: true, neededJoules: work, availableJoules: this.charge };
    }
    this.ledger.spend('chill', work, `pumped ${Qc.toFixed(0)} J out, COP ${cop.toFixed(2)}`);
    this.ledger.trackHeat(work); // the compressor's share ends up as heat behind you
    const wasteBehind = Qc; // rejected heat appears behind the caster
    if (target) target.heat = Math.max(0, (target.heat ?? 0) - Qc);
    return { ok: true, work, pumpedJoules: Qc, rejectedJoules: wasteBehind, cop, iceKg: freeze ? massOfIce : 0 };
  }

  /**
   * LIGHT — a glow orb. It is a blackbody-ish emitter, so its colour is its
   * temperature (Wien) and its drain is its radiated power (Stefan-Boltzmann).
   * Burn it for 20 minutes and it will genuinely empty a big battery.
   */
  /**
   * If the store cannot pay for the requested temperature, the orb DIMS —
   * it does not radiate light that nobody paid for. An earlier version of this
   * function clipped the cost to whatever was left and emitted full brightness,
   * which was a free-energy bug caught by the ledger test, not by eye.
   */
  light({ temperature = 2600, area = 0.02, duration = 1 }) {
    const requested = exitance(temperature, 0.9) * area;
    const want = requested * duration;
    if (want > this.charge) {
      // Affordable power for this interval; solve back to the temperature that
      // produces it. The filament temperature follows the budget, not the wish.
      const affordable = Math.max(0, this.charge / Math.max(1e-6, duration));
      const tEff = Math.pow(Math.max(1, affordable / (0.9 * area * SI.sigma)), 0.25);
      const cost = affordable * duration;
      if (cost > 0) {
        this.ledger.spend('light', cost, `dimmed to ${tEff.toFixed(0)} K, store starved`);
        this.ledger.trackRadiation(cost);
      }
      return {
        watts: affordable,
        cost,
        dimmed: true,
        requestedWatts: requested,
        peakNanometres: (wienPeak(tEff) * 1e9).toFixed(0),
      };
    }
    this.ledger.spend('light', want, `${requested.toFixed(0)} W radiated from ${temperature} K`);
    this.ledger.trackRadiation(want);
    return { watts: requested, cost: want, dimmed: false, peakNanometres: (wienPeak(temperature) * 1e9).toFixed(0) };
  }
}

const ZEROISH = new V(0, 0, 0);

/** Crude closed-form drag loss over a flat trajectory, for the damage bill. */
export function dragLoss(projectile, distance) {
  const a = projectile.aerodynamic ?? { rho: SI.air, cd: 0.47, area: 0.01 };
  const k = (0.5 * a.rho * a.cd * a.area) / projectile.mass;
  const v0 = projectile.velocity.mag();
  const vEnd = v0 * Math.exp(-k * distance / Math.max(1, v0 * 0.5));
  return Math.max(0, 0.5 * projectile.mass * (v0 * v0 - vEnd * vEnd));
}

/**
 * The islands themselves. They float, which is impossible — so here is the
 * invoice they pay: a levitation store must supply force * distance against
 * any perturbation, and it leaks. Each island carries a charge and an
 * equilibrium altitude. Push it down and it gains potential; let the charge
 * run out and it comes down, at g, forever.
 */
export class LevitationStore {
  constructor({ island, altitude, capacity = 9e9, leakWatts = 4.2e5 }) {
    this.island = island;
    this.altitude = altitude;
    this.ledger = new Ledger(`island:${island.x},${island.z}`);
    this.ledger.credit('ley', capacity, 'primordial charge');
    this.capacity = capacity;
    this.leak = leakWatts;
    this.massEstimate = 4.0 / 3 * Math.PI * island.r ** 3 * 2400; // basalt-ish
  }
  get remainingFraction() {
    return this.ledger.stored / this.capacity;
  }
  /** Years of hold-time left at the current leak rate. */
  get yearsLeft() {
    return this.ledger.stored / this.leak / (365 * 24 * 3600);
  }
  tick(dt) {
    if (this.ledger.stored <= 0) return false; // falling, and lawful about it
    this.ledger.stored = Math.max(0, this.ledger.stored - this.leak * dt);
    return true;
  }
  /** Energy needed to raise the island by dh. */
  raiseBy(dh) {
    const j = this.massEstimate * SI.g0 * dh;
    this.ledger.spend('levitation', j, `raised ${this.massEstimate.toExponential(2)} kg by ${dh} m`);
    this.altitude += dh;
    return j;
  }
}

export { irradiance, kinetic, Ledger, V, SI };
