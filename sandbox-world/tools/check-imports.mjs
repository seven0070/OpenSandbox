/**
 * tools/check-imports.mjs — resolve the module graph the way the browser will.
 *
 * A blank page with no console output is the most common way a three.js app
 * dies, and it is almost always a bare specifier that no import map covers or an
 * addon importing a symbol that was renamed upstream. This script applies the
 * import map from index.html to every import in the project, asserts each file
 * exists, and asserts each named import actually exists in the target module.
 * Run it with `npm run check`.
 */
import { readFile } from 'node:fs/promises';
import { dirname, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ENTRIES = (process.argv[2] ? [process.argv[2]] : ['src/universe.js', 'src/archipelago.js']);
const PAGES = ['index.html', 'archipelago.html'];

const pages = {};
for (const h of PAGES) pages[h] = await readFile(resolve(ROOT, h), 'utf8').catch(() => '');
const map = JSON.parse((pages['index.html'] || pages['archipelago.html']).match(/<script type="importmap">([\s\S]*?)<\/script>/)[1]).imports;

const files = new Set();
const problems = [];

function resolveSpecifier(spec, fromFile) {
  for (const [k, v] of Object.entries(map)) {
    if (k.endsWith('/') ? spec.startsWith(k) : spec === k) {
      return resolve(ROOT, v + spec.slice(k.length));
    }
  }
  if (spec.startsWith('.')) return resolve(dirname(fromFile), spec);
  return null; // bare with no import map entry -> browser would 404
}

async function walk(file) {
  if (files.has(file)) return;
  files.add(file);
  let src;
  try {
    src = await readFile(file, 'utf8');
  } catch (e) {
    problems.push(`MISSING  ${relative(ROOT, file)} — could not be read (${e.code})`);
    return;
  }
  const specs = [
    // [^;']* rather than [\s\S]*?: it must span newlines (multi-line named
    // imports are the common style) but never cross a quote, which is how an
    // earlier version matched the string literal 'from' inside genesis.js and
    // how a too-greedy-then-too-tight fix nearly hid genesis.js from the graph.
    ...[...src.matchAll(/^\s*import\s+[^;']*?from\s*['"]([^'"]+)['"]/gm)].map((m) => m[1]),
    ...[...src.matchAll(/^\s*export\s+[^;']*?from\s*['"]([^'"]+)['"]/gm)].map((m) => m[1]),
    ...[...src.matchAll(/^\s*import\s*['"]([^'"]+)['"]/gm)].map((m) => m[1]),
    ...[...src.matchAll(/import\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1]),
  ];
  for (const spec of specs) {
    const target = resolveSpecifier(spec, file);
    if (!target) {
      problems.push(`UNMAPPED ${relative(ROOT, file)} imports '${spec}' — the import map in index.html does not cover it`);
      continue;
    }
    const rel = relative(ROOT, target);
    try {
      await readFile(target, 'utf8');
    } catch {
      problems.push(`BROKEN   ${relative(ROOT, file)} -> ${rel} (mapped from '${spec}') does not exist on disk`);
      continue;
    }
    // named-import existence check
    const named = [
      ...src.matchAll(new RegExp(`import\\s*\\{([^}]*)\\}\\s*from\\s*['"]${spec.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}['"]`, 'g')),
    ].flatMap((m) => m[1].split(',').map((x) => x.trim().split(/\s+as\s+/)[0]).filter(Boolean));
    if (named.length) {
      const mod = await import('file://' + target).catch(() => null);
      if (mod) {
        for (const name of named) {
          if (!(name in mod) && !(name === 'default' && 'default' in mod)) {
            problems.push(`NO EXPORT '${name}' in ${rel}, imported by ${relative(ROOT, file)}`);
          }
        }
      } else if (rel.includes('three.module') === false && !rel.endsWith('.js')) {
        problems.push(`SKIP check ${rel} (not loadable in node)`);
      }
    }
    await walk(target);
  }
}

for (const e of ENTRIES) await walk(resolve(ROOT, e));

// assets the HTML itself asks for
for (const [name, html] of Object.entries(pages)) {
  for (const ref of [...html.matchAll(/(?:src|href)="(\.\/[^"]+)"/g)].map((m) => m[1])) {
    try {
      await readFile(resolve(ROOT, ref));
    } catch {
      problems.push(`BROKEN   ${name} references ${ref}, which is not on disk`);
    }
  }
}

console.log(`module graph: ${files.size} files reachable from ${ENTRIES.join(', ')}`);
console.log(`import map:   ${Object.keys(map).length} entries -> ${JSON.stringify(map)}`);
const real = problems.filter((p) => !p.startsWith('SKIP'));
if (real.length) {
  console.log('\nproblems:');
  for (const p of real) console.log('  ✗ ' + p);
  process.exit(1);
}
console.log('\n✓ every specifier resolves and every named import exists');
for (const f of [...files].sort()) console.log('   ' + relative(ROOT, f));
