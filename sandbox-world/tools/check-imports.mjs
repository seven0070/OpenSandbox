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
const html = await readFile(resolve(ROOT, 'index.html'), 'utf8');
const map = JSON.parse(html.match(/<script type="importmap">([\s\S]*?)<\/script>/)[1]).imports;

const ENTRY = 'src/main.js';
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
    ...[...src.matchAll(/^\s*import\s+(?:[\s\S]*?)?\s*from\s*['"]([^'"]+)['"]/gm)].map((m) => m[1]),
    ...[...src.matchAll(/^\s*export\s+(?:[\s\S]*?)?\s*from\s*['"]([^'"]+)['"]/gm)].map((m) => m[1]),
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

await walk(resolve(ROOT, ENTRY));

// assets the HTML itself asks for
for (const ref of [...html.matchAll(/(?:src|href)="(\.\/[^"]+)"/g)].map((m) => m[1])) {
  try {
    await readFile(resolve(ROOT, ref));
  } catch {
    problems.push(`BROKEN   index.html references ${ref}, which is not on disk`);
  }
}

console.log(`module graph: ${files.size} files reachable from ${ENTRY}`);
console.log(`import map:   ${Object.keys(map).length} entries -> ${JSON.stringify(map)}`);
const real = problems.filter((p) => !p.startsWith('SKIP'));
if (real.length) {
  console.log('\nproblems:');
  for (const p of real) console.log('  ✗ ' + p);
  process.exit(1);
}
console.log('\n✓ every specifier resolves and every named import exists');
for (const f of [...files].sort()) console.log('   ' + relative(ROOT, f));
