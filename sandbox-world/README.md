# Arcane Physics — a fantasy world that pays its debts

A first-person (and WebXR-capable) virtual world where floating islands, two moons,
kinetic spells and a heat-pumping freeze ray all obey real physical law. Nothing here
is a physics *imitation*: gravity, drag, buoyancy, collisions, optics, thermodynamics
and an energy ledger live in one pure module that is unit-tested head-less. The renderer
is a viewer for that module, not a second simulation.

```
sandbox-world/
├── index.html              the shell + HUD + import map          (no build step)
├── src/
│   ├── physics.js          THE LAWS. pure, no DOM, no deps       (tested)
│   ├── fantasy.js          THE IMPOSSIBLE, PRICED. spells as transducers (tested)
│   └── main.js             three.js viewer, player, HUD, XR
├── vendor/                 three r169 + Sky/Water addons, local  (no CDN)
├── srv/serve.mjs           60-line static server
├── tests/                  41 assertions: law suite + 60 s gameplay soak
└── tools/                  import-graph check + headless boot harness
```

## Run it

```bash
cd sandbox-world
npm run serve            # → http://localhost:8765   (PORT= to change)
npm test                 # 41 headless assertions on the laws themselves
npm run verify           # import graph + tests + headless boot of the real app
```

No install is needed to *run* the world: `vendor/` is committed alongside it and there
is no bundler, so `python3 -m http.server` in this folder works identically.
`npm install` is only needed if you want to bump `three`.

**You cannot open `index.html` with a double-click.** ES modules and the import map are
subject to the origin rules, so `file://` will refuse to load them. Any static file
server is enough.

## Take it elsewhere

The folder is the artifact. It has one third-party dependency, vendored, and zero build
output, so these all work unchanged:

| Target | What to do |
|---|---|
| Any static host / GitHub Pages | drop the folder, serve `/index.html` |
| itch.io | zip the folder, mark it "html5, plays in browser" |
| Your own box | `npm run serve` behind any reverse proxy |
| A headset | serve it over **HTTPS** on the LAN, open in Quest Browser / Wolvic, press *Enter in VR* |
| Another repo / project | copy `src/physics.js` + `src/fantasy.js`; they import nothing |
| A server-side simulation | import `src/physics.js` from Node — it is engine-agnostic and has no `window` references |

To reach a real headset, HTTPS is mandatory (WebXR requires a secure context).
`npx http-server -S -C cert.pem -K key.pem` is enough on a LAN. The XR path is wired
in `main.js`: thumbstick locomotion, trigger casts the lance, grip lights an orb, and
the same `World` instance is stepped either way — a headset is a different camera, not a
different universe.

## The bargain this world strikes

Fantasy is allowed to exist; it is not allowed to be free.

| Impossible thing | The bill it pays |
|---|---|
| Floating islands | a levitation store leaks watts; run it out and the island falls at 9.80665 m/s² |
| Levitation spell | `F = mg`, billed per frame against your store; run dry mid-hold and the fraction you *could* afford is the lift you *get* |
| Kinetic lance | ½mv² leaves the store, and the caster is thrown backwards by exactly mv — recoil is applied, not described |
| Freeze ray | it is a heat pump: cost is bounded by Carnot, deep cold is brutal, and the extracted heat is dumped behind you |
| Light orb | radiates σT⁴·A·ε, so a 15 cm incandescent sphere costs ~22 kW and drains a full charge in minutes. Starve it and it **dims**, because nobody gets something for nothing |
| Two moons | real masses, so they tug you at ~10⁻⁴ m/s² and drive the tide the shoreline actually follows |
| Feather and anvil | identical acceleration; only drag ever disagrees, so the feather floats and the anvil does not |

Everything the HUD shows is read out of the kernel: felt gravity, kinetic and potential
energy, contacts per second, terminal velocity of the rain, and the ledger's audit line.
That last one is the interesting number — it is the energy the world has created, and if
you ever see it leave zero, the build is broken.

## What is enforced, not asserted

`npm test` is the part that makes this claim checkable rather than rhetorical:

- equivalence principle, ballistic arcs vs the analytic solution
- momentum conserved to 1e-12 through collisions; energy may only go **down**, and the
  deficit must reappear as heat in the bodies (it is booked, not deleted)
- elastic systems conserve KE exactly, inelastic ones conserve KE + heat exactly
- determinism: a jittery frame schedule and a smooth one produce the same world, because
  the step is fixed at 240 Hz
- Snell, TIR past 48.6°, Fresnel, inverse-square, Wien, Stefan–Boltzmann, Doppler
- Archimedes: the log floats, the anchor sinks, neutral buoyancy hovers
- `Ledger.spend()` throws `NO_FREE_ENERGY` — an overdraft spell is unrepresentable
- a 60 s soak that casts everything, drains the caster to zero, and audits every joule

`npm run verify` adds two more: `check-imports` walks the module graph exactly as the
browser's import map will, and `boot-check` **runs the real `main.js`** head-less against
real three.js with only `WebGLRenderer` and the DOM stubbed (the DOM's id list is parsed
out of `index.html`, so a `$('v-typo')` throws there as it does in Chrome). Both caught
live bugs during development: a top-level TDZ crash that would have shipped a blank page,
a `World.step()` that replaced body objects and thereby stranded every mesh, and a light
spell that emitted unbilled lumens when the store ran dry.

## Honest limits

- **No GPU, no headset, no display in this sandbox.** The world is served to a browser;
  it was verified by tests and a headless boot, not by a human looking at it here.
- The integrator is semi-implicit Euler at a fixed step: symplectic and bounded, not
  exact. Tolerances in the tests say so instead of hiding it.
- Collisions are impulse-based against analytic surfaces. It will not survive a
  10 000-object crowd, and there is no friction model, no rotation dynamics, no sound.
- `terrainHeight()` is shared by the mesh builder and the collision solver on purpose:
  geometry and physics cannot disagree. Water *visuals* come from the GPU normal map
  while water *physics* comes from `waterSurface()` — a documented split, ripples are
  decoration, the tide level is not.
