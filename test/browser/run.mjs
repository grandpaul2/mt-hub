// Runs the browser suites against a fresh local hub each, in headless Chromium.
//
//   node test/browser/run.mjs              every suite except the ones that need the internet
//   node test/browser/run.mjs tree moves   just those
//   node test/browser/run.mjs --all        everything, including previews (fetches real sites)
//
// Builds the page and the server first, then runs the suites side by side (each has its own
// hub and browser, so they can't disturb each other), up to one per CPU core.
// --serial runs one at a time. Screenshots land in test/browser/out/.
import { execFileSync, spawn } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { join } from 'node:path';

const here = import.meta.dirname;
const root = join(here, '..', '..');
const NEEDS_NET = ['previews'];

const args = process.argv.slice(2);
const all = readdirSync(here).filter((f) => f.endsWith('.mjs') && !['lib.mjs', 'run.mjs'].includes(f)).map((f) => f.slice(0, -4)).sort();
const named = args.filter((a) => !a.startsWith('--'));
const unknown = named.filter((n) => !all.includes(n));
if (unknown.length) {
  console.error(`no such suite: ${unknown.join(', ')} (have: ${all.join(', ')})`);
  process.exit(2);
}
const suites = named.length ? named : all.filter((s) => args.includes('--all') || !NEEDS_NET.includes(s));

const bin = join(root, 'bin', 'mthub-test');
execFileSync('make', ['web'], { cwd: root, stdio: 'inherit' });
execFileSync('go', ['build', '-o', bin, './cmd/mthub'], { cwd: root, stdio: 'inherit' });

const runOne = (s) => new Promise((resolve) => {
  const start = Date.now();
  const p = spawn('node', [join(here, `${s}.mjs`)], { env: { ...process.env, MTHUB_BIN: bin } });
  let out = '';
  p.stdout.on('data', (d) => (out += d));
  p.stderr.on('data', (d) => (out += d));
  const timer = setTimeout(() => p.kill('SIGTERM'), 180000);
  p.on('close', (code) => {
    clearTimeout(timer);
    resolve({ s, out, pass: code === 0 && out.includes('all passed'), secs: (Date.now() - start) / 1000 });
  });
});

const t0 = Date.now();
const width = args.includes('--serial') ? 1 : availableParallelism();
const queue = [...suites];
const results = [];
await Promise.all(Array.from({ length: Math.min(width, queue.length) }, async () => {
  for (let s; (s = queue.shift()); ) {
    const r = await runOne(s);
    results.push(r);
    const n = (r.out.match(/^ok {2}/gm) ?? []).length;
    console.log(`${r.pass ? 'pass' : 'FAIL'}  ${r.s.padEnd(15)} ${String(n).padStart(3)} ok  ${r.secs.toFixed(0)}s`);
    // The whole output of a failed suite: which checks failed, and any crash.
    if (!r.pass) console.log(r.out.split('\n').filter((l) => !l.startsWith('ok  ')).map((l) => `      ${l}`).join('\n'));
    // What settle() has to say (SETTLE_AUDIT=1 or SETTLE_REPORT=1; see lib.mjs).
    else for (const l of r.out.split('\n').filter((l) => /^(LATE|WAITS|FULL) /.test(l))) console.log(`      ${l}`);
  }
}));
const failed = results.filter((r) => !r.pass).map((r) => r.s);
const skipped = all.filter((s) => !suites.includes(s));
console.log(`\n${suites.length - failed.length}/${suites.length} suites passed in ${((Date.now() - t0) / 1000).toFixed(0)}s${skipped.length ? ` (skipped: ${skipped.join(', ')})` : ''}`);
process.exit(failed.length ? 1 : 0);
