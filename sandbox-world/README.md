# The Void

> *Build me a virtual world, a VR, that obeys the laws of reality but is a fantasy.*
> *Build a universe which shapes to how I would want it inside the sandbox.*

Two pages, one kernel.

| page | what it is |
|---|---|
| `index.html` | **the void** — nothing exists. No ground, no sky, no sun, no down, and no time until something changes. You create everything. |
| `archipelago.html` | **a created world** — a lava archipelago with a sea and a low sun. The same physics, pre-populated. It is also one button inside the void: `archipelago` declares that whole world as a single act of creation. |

The premise, stated as a rule:

**Fantasy is content. The laws are contracts.**

Anything you want is allowed; nothing is free of consequence. Creation is free — you, the creator, are not billed, and no one is in charge of your gravity except you. Governance is not free: a created thing is not editable. `mutate` is refused by the kernel, not discouraged by a UI.

---

## Run it

```bash
cd sandbox-world
npm run serve          # http://localhost:8765/          (the void)
                       # http://localhost:8765/archipelago.html  (a created world)
npm run verify         # import graph + 77 physics tests + both boot checks
npm run boot void      # headless: load the real page, run its frames, assert its laws
```

No build step, no bundler, no CDN, and **no `dependencies` field in `package.json`**: `three.js`
r169 is vendored in `vendor/`, and each page maps it there with its own
`<script type="importmap">`. That map is the single source of truth for resolution —
`tools/boot-loader.mjs` reads it out of the HTML instead of duplicating it, so Node and Chrome
resolve the identical files. An npm-installed `three` is not just unnecessary here, it is a bug
waiting to happen: the harness quietly passed for a while against `node_modules/three` while the
browser used the vendored copy, which meant the shipped copy was never the tested copy. If you
see a `dependencies` entry reappear, delete it and let `vendor/` answer.

**Portable.** `cp -R sandbox-world ../void && cd ../void && npm run serve` works from any
folder, in this container or anywhere else with Node — the artifact is the folder, not the
server. To take it further — write the bundle outside the repo, so a build product never becomes a tracked file:

```bash
bash tools/package-standalone.sh ~/arcane-physics-standalone.zip
```

It runs `npm run verify`, re-extracts the result somewhere else and runs `npm run verify` *there*, and **refuses to
produce it unless the bundle passes `npm run verify` after being extracted into a fresh
directory** — portability that is tested, not asserted. Two honest caveats it writes into the
bundle's own README: ES modules will not load from `file://` (no origin to grant CORS), so a
double-clicked `index.html` is blank in any mainstream browser and needs a static server; and
`universe.json` is deliberately excluded, since an absent charter means "nothing exists yet",
which is the state this ships in. WebXR is
wired (`ENTER VR` appears when a headset is present) but **cannot be verified here** — this
sandbox has no GPU, no browser, no display. What is verified is the physics, the render-loop
contract, and the accounting; the pixels are yours to look at.

## The void page

**You.** A 90 kg body with no ground under it, 40 kg of reaction mass, and a suit that throws
mass instead of pushing on things. `W A S D Q E` thrust, `Shift` harder, `Space` brake. On the
archipelago, `W` pushes against rock at 4.2 m/s; here it ejects 0.5 kg of propellant at 3 km/s
and buys you Δv = v_e·ln(90/89.5) = **16.7 m/s** — the Tsiolkovsky rocket equation is the only
means of locomotion, and the 40 kg is all you get. The exhaust is a real body in the world,
carrying the opposite momentum; momentum balance is asserted to 0.0e+0.

**Palette.** Nineteen archetypes (`src/genesis.js`): pebble, boulder, gravel-world, moonlet,
moon, Mars-world, ocean, super-Earth, Earth-analog, gas giant, rock star, brown dwarf, white
dwarf, neutron star, black hole, molecular cloud, nebula, comet, candle. Click one and it is
made in front of you. Big things are made *far* from you on purpose: `defaultRange()` puts a star
4×10⁸ m out and a planet 4×10⁶ m out, because spawning a 2×10³⁰ kg star on your own position is
not creation, it is an execution — and gravity does not care about your intentions.

**Console.** Everything the buttons do is a line of text, and the text is the more honest path:

```
create star name sol
create earthlike name terra at 1.496e11 0 0 orbit sol
create gasgiant name jup at 7.78e11 0 0 orbit sol
make 400 pebble                        12.7 m/s²
erase terra
spec gravity 9.81                      write a number onto the world
spec ground -4000                        it will not be believed
history                                the ledger, with drift
archipelago | void                       declare that world, or erase everything
```

`resolve()` in `src/genesis.js` turns `orbit sol` into the circular velocity at that radius, and
refuses a request that would place a planet inside its star.

**Time.** `World.advance()` asks `activity()` first: masses moving, light being emitted, heat
flowing, charge being spent. An unchanged void returns zero, so nothing accrues — the clock is
relational, not a stream. Create a warm body and `evolving` flips to true on its own, because a
300 K pebble in a 2.725 K universe *is* changing: it radiates. Erase everything and `time` stops
where it was. `timeline()` is the record of your acts, which is the only clock that means anything
here.

**Light and heat are the same law.** Colour comes from `blackbodyColor(T)` (Helland's fit to
Planck), so a 2000 K ember is red and a 30000 K star is blue-white without anyone writing that
down; `luminosity = 4πR²σT⁴` sets each body's real wattage, and the six brightest become actual
`PointLight`s with `decay: 2` — inverse square, as written — and `distance: 0`, so light does not
stop existing at an arbitrary radius. The intensity you see is `0.0016 · L^0.34`: a **log
compression**, disclosed on the page, because a sun at true brightness is a white screen and a
black hole at true darkness is invisible.

**Your body is drawn by the same law.** No `bodyColor` table exists; the palette you see is
temperature, from the same function as the sky.

## Shaping from outside: `universe.json` is the charter

`universe.json` (gitignored — it is *your* universe, not part of the artifact) is what the page
saves and loads:

```json
{ "spec": { "mode": "void", "gravity": 0, "ambientT": 2.725 },
  "created": [ { "kind": "star", "name": "sol", "mass": 1.98892e30, … } ] }
```

* The page POSTs it on `save`, and `srv/serve.mjs` writes it and broadcasts on
  `GET /events` (Server-Sent Events).
* Edit or delete the file in the workspace — or ask me to write it in chat — and every open page
  reloads that universe within a second. `rm universe.json` is "back to nothing".
* Absent file = empty universe. That is why the repo ships without one.

So "shapes to how I would want it" is not a metaphor: the running world is a file, and a file is
something you can write from anywhere. A charter that is not valid JSON is refused with 400 and
never written, so a typo in an editor cannot brick a universe — and the round trip is asserted
lossless (`tests/void.test.mjs`), including atmospheres, which is exactly where that test caught a
real bug: a saved `{ mass, material }` atmosphere was being handed to the pressure formula as an
object and came back as NaN air.

## What is real here

`src/physics.js` is the kernel: dependency-free, no `three.js` import, no DOM, no `Math.random`,
and every constant named with its source. `tests/` (77 assertions) check it against textbook
values, not against snapshots of itself.

| you are told | because |
|---|---|
| `9.821 m/s²` at an Earth's surface | `GM/R²` with R derived from 5.9722×10²⁴ kg at 5514 kg/m³ |
| `11186 m/s` escape, `29788 m/s` to orbit | `√(2GM/R)`, `√(GM/R)` |
| a 1 M☉ star lasts `10.4 Gyr` | 0.1% of mass fused, L = M^3.5 |
| H₂ escapes a Moon, not the Earth | Jeans λ > 36 holds, 20–36 leaks |
| your water boils at 99.4 °C | the bound atmosphere's own pressure, `P = GMm/R²` |
| a rock falls into a 1 M☉ sun in ~2 months | free-fall time `√(3π/32Gρ)` — so make a *cloud* and wait |
| `1.000` Kepler ratio at 1 AU | `resolvePair` integrates the real inverse-square field |
| `drift 0.0e+0 J` in the ledger | the ledger sums four buckets and compares each step |

Ground, where it exists, is not a plane: it is an analytic height field (Perlin fBm + ridged
craters, computed identically in JS and in the shader from `terrainGLSL()`), and a body rests on
it because `collideHalfSpace` projects its velocity onto the analytic surface normal.

A number is only as honest as its radius floor. Bodies smaller than **0.22 m** render at 0.22 m,
because below that a sphere is a handful of pixels at any camera distance; the HUD prints the real
radius and says so on the page.

## Layout

```
index.html                the void          ┐
src/universe.js           its viewer        ├─ all four import the same kernel
src/genesis.js            the creator        │
archipelago.html          a created world   │
src/archipelago.js        its viewer        ┘
src/physics.js            the laws (no imports)
src/fantasy.js            that world's two invented laws
srv/serve.mjs             static + POST /universe.json + GET /events
tests/                    77 assertions
tools/                    boot-check (headless, per page), check-imports, build-onefile, package-standalone
```

The three-way rule that keeps this honest: the HUD, the shaders, and `collideHalfSpace` read
`terrainHeight`/`SEA_LEVEL` from the kernel. There is no second copy to drift.

## The things I will not pretend

* **Pixels and headsets are unverified.** No GPU here. What *is* verified, by `npm run boot void`:
  over 300 frames of the real `index.html` run without throwing (the harness asserts `framesRun > 300`), no NaN anywhere, 21 HUD ids all
  present, the ledger still balances, an empty universe has no time, and a created star starts the
  clock.
* **The n-body is O(n²) with no BH tree**, so a `make 400` is fine and a `make 100000` is not
  attempted. Collisions use an impulse solver with Baumgarte stabilisation — good for resting
  contact, not a continuum-mechanics solver. A moon you throw at 5 km/s deforms, and the kernel
  tells you via the Roche limit rather than simulating the debris: **fluid Roche is `2.44·R_p·
  (ρ_p/ρ_s)^⅓`**.
* **You can do anything, but you cannot undo consequence.** `spec ground -4000` prints the real
  free-fall time into that density and declines.
