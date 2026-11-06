/**
 * tools/boot-loader.mjs — a Node module-resolution hook, used by boot-check.
 *
 * It replaces the bare specifier 'three' with a shim that re-exports the real
 * vendored three.js and swaps exactly ONE class: WebGLRenderer, which cannot
 * exist without a GPU. The generated source is evaluated on the main thread, so
 * the app's own bookkeeping (frame counter, error list) stays authoritative —
 * this file only supplies the class it is not allowed to build here.
 */
let root = process.cwd();

export function initialize(data) {
  if (data?.root) root = data.root;
}

const SHIM = 'virtual:three-headless';

export async function resolve(specifier, context, nextResolve) {
  if (specifier === 'three') return { url: SHIM, shortCircuit: true };
  return nextResolve(specifier, context);
}

export async function load(url, context, nextLoad) {
  if (url !== SHIM) return nextLoad(url, context);
  const real = new URL('vendor/three.module.js', `file://${root}/`).href;
  return {
    format: 'module',
    shortCircuit: true,
    source: `
      export * from ${JSON.stringify(real)};

      const on = (t, f) => (globalThis.__bootOn || globalThis.__bootNoop)(t, f);

      // Behaves like the real renderer for every call this app makes, and draws
      // nothing. Anything the app asks of a GPU is answered with a constant.
      export class WebGLRenderer {
        constructor() {
          this.domElement = {
            nodeName: 'CANVAS', style: {},
            addEventListener: on, removeEventListener() {},
            requestPointerLock() { globalThis.__bootPointerLock = true; globalThis.__bootOn?.('pointerlockchange'); },
            getBoundingClientRect: () => ({ left: 0, top: 0, width: 1440, height: 900 }),
            width: 1440, height: 900,
          };
          this.shadowMap = { enabled: false, type: 1 };
          this.xr = {
            enabled: false,
            getController(i) {
              const c = {
                isXRController: true, hand: i ? 'right' : 'left', children: [],
                matrixWorld: { elements: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, i ? 0.2 : -0.2, 1.3, -0.3, 1] },
                add(o) { c.children.push(o); }, remove() {}, addEventListener: on,
                getWorldPosition(v) { return v.set(i ? 0.2 : -0.2, 1.3, -0.3); },
                getWorldQuaternion(q) { return q.set(0, 0, 0, 1); },
                getWorldDirection(v) { return v.set(0, 0, -1); },
              };
              return c;
            },
            setSession: async () => { globalThis.__bootVR = true; },
          };
          this.outputColorSpace = 'srgb';
          this.toneMapping = 4;
          this.toneMappingExposure = 1;
          this.capabilities = { isWebGL2: true, getMaxAnisotropy: () => 4, precision: 'highp' };
          this.info = { render: { calls: 0, triangles: 0 }, memory: { geometries: 0, textures: 0 }, programs: [] };
          this.extensions = { get: () => null, has: () => false };
          this.properties = { get: () => ({}) };
          this.state = { buffers: { depth: { setReversed() {}, test: { setEnabled() {} } } } };
        }
        setPixelRatio(v) { this.__pr = v; }
        getPixelRatio() { return this.__pr || 1; }
        setSize(w, h) { this.__size = [w, h]; }
        getSize(v) { return v.set(1440, 900); }
        setAnimationLoop(cb) { this.__cb = cb; }
        getAnimationLoop() { return this.__cb || null; }
        render(scene, camera) {
          globalThis.__bootFrames = (globalThis.__bootFrames || 0) + 1;
          if (!scene || !camera) throw new Error('render() called without a scene or camera');
          scene.updateMatrixWorld?.(true);
        }
        compile() {}
        dispose() {}
        clear() {}
        setRenderTarget() {}
        getRenderTarget() { return null; }
        getContext() { return null; }
        __tick() {
          if (!this.__cb) throw new Error('no animation loop was registered');
          this.__cb((globalThis.__bootNow || 0) / 1000);
        }
      }
      export const __headlessThreeShim = true;
    `,
  };
}
