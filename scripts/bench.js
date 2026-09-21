#!/usr/bin/env node
// Benchmarks the searches on random connected graphs of increasing size, several iterations each.
// Output: media/bench.json, inlined into media/charts.html.
//
//   node scripts/bench.js                 # real Jev, reads TYPESAFE_API_KEY from .env
//   node scripts/bench.js --mock          # no key
//   node scripts/bench.js --sizes 8,16,32 --iters 3 --concurrency 6
import { readFile, writeFile } from 'node:fs/promises';
import { jevFirstSearch, jevStar } from '../src/index.js';

const args = process.argv.slice(2);
const flag = (name, fallback) => { const i = args.indexOf(name); return i === -1 ? fallback : args[i + 1]; };
const mock = args.includes('--mock');
const SIZES = flag('--sizes', '8,16,32,64,128').split(',').map(Number);
const ITERS = Number(flag('--iters', 5));
const CONCURRENCY = Number(flag('--concurrency', 6));
try { process.loadEnvFile('.env'); } catch {}

let client;
if (mock) {
  const { MockJev } = await import('../src/mock.js');
  client = new MockJev();
} else {
  if (!process.env.TYPESAFE_API_KEY) { console.error('TYPESAFE_API_KEY is not set. Put it in .env, or run with --mock.'); process.exit(1); }
  const { TypeSafeClient } = await import('@typesafe-ai/sdk');
  client = new TypeSafeClient({ retry: { maxRetries: 1 } });
}
let model = null;
const recorder = { async systemOne(r) { const res = await client.systemOne(r); model = res.model; return res; } };

// Seeded RNG so the graphs are the same every run; only Jev's answers vary.
function rng(seed) {
  return () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
function randomGraph(n, seed) {
  const rand = rng(seed);
  const names = Array.from({ length: n }, (_, i) => `n${i}`);
  const adj = Object.fromEntries(names.map((x) => [x, new Set()]));
  const link = (a, b) => { adj[a].add(b); adj[b].add(a); };
  for (let i = 1; i < n; i++) link(names[i], names[Math.floor(rand() * i)]); // spanning tree
  const extra = Math.round(n * 0.6); // bring average degree to about 3
  for (let k = 0; k < extra; k++) { const a = names[Math.floor(rand() * n)], b = names[Math.floor(rand() * n)]; if (a !== b) link(a, b); }
  const graph = Object.fromEntries(names.map((x) => [x, [...adj[x]]]));
  const dist = bfsDistances(graph, names[0]);
  const far = names.filter((x) => dist.get(x) >= 3);
  const goal = far.length ? far[Math.floor(rand() * far.length)] : names[n - 1];
  return { graph, start: names[0], goal, optimal: dist.get(goal) };
}
function bfsDistances(graph, start) {
  const dist = new Map([[start, 0]]);
  const queue = [start];
  while (queue.length) { const v = queue.shift(); for (const w of graph[v]) if (!dist.has(w)) { dist.set(w, dist.get(v) + 1); queue.push(w); } }
  return dist;
}
function bfs(graph, start, goal) {
  const parent = new Map([[start, null]]);
  const queue = [start];
  let visited = 0;
  while (queue.length) {
    const v = queue.shift();
    visited++;
    if (v === goal) { const p = []; for (let c = v; c !== null; c = parent.get(c)) p.unshift(c); return { path: p, visited }; }
    for (const w of graph[v]) if (!parent.has(w)) { parent.set(w, v); queue.push(w); }
  }
  return { path: null, visited };
}
function dfs(graph, start, goal) {
  const parent = new Map([[start, null]]);
  const stack = [start];
  const seen = new Set();
  while (stack.length) {
    const v = stack.pop();
    if (seen.has(v)) continue;
    seen.add(v);
    if (v === goal) { const p = []; for (let c = v; c !== null; c = parent.get(c)) p.unshift(c); return { path: p, visited: seen.size }; }
    for (const w of graph[v]) if (!seen.has(w)) { if (!parent.has(w)) parent.set(w, v); stack.push(w); }
  }
  return { path: null, visited: seen.size };
}
function timed(fn) {
  const t0 = performance.now();
  let r;
  for (let i = 0; i < 50; i++) r = fn();
  return { ...r, elapsedMs: (performance.now() - t0) / 50 };
}

const jobs = [];
for (const size of SIZES) for (let iter = 0; iter < ITERS; iter++) jobs.push({ size, iter, seed: size * 1000 + iter });

const runs = [];
let done = 0;
async function work(job) {
  const { graph, start, goal, optimal } = randomGraph(job.size, job.seed);
  const base = { size: job.size, iter: job.iter, optimal };
  const row = (algo, r) => ({
    ...base, algo,
    found: !!r.path, pathLength: r.path ? r.path.length - 1 : null,
    optimality: r.path ? optimal / (r.path.length - 1) : 0,
    visited: Array.isArray(r.visited) ? r.visited.length : r.visited,
    jevCalls: r.jevCalls ?? 0, inputTokens: r.inputTokens ?? 0,
    elapsedMs: r.elapsedMs, costUsd: r.estimatedCostUsd ?? 0,
    probability: r.probability ?? null, reason: r.reason ?? 'found',
  });
  runs.push(row('bfs', timed(() => bfs(graph, start, goal))));
  runs.push(row('dfs', timed(() => dfs(graph, start, goal))));
  const jfs = await jevFirstSearch(graph, start, goal, { client: recorder });
  runs.push(row('jfs', jfs));
  const star = await jevStar(graph, start, goal, { client: recorder });
  runs.push(row('star', star));
  done++;
  console.log(`[${done}/${jobs.length}] n=${job.size} #${job.iter}  optimal ${optimal}  jfs ${jfs.path ? jfs.path.length - 1 : `none (${jfs.reason})`} in ${jfs.jevCalls} calls  jev* ${star.path ? star.path.length - 1 : 'none'} in ${star.jevCalls} calls`);
}
const queue = [...jobs];
await Promise.all(Array.from({ length: CONCURRENCY }, async () => { while (queue.length) await work(queue.shift()); }));

runs.sort((a, b) => a.size - b.size || a.iter - b.iter || a.algo.localeCompare(b.algo));
const mean = (xs) => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
const summary = [];
for (const size of SIZES) for (const algo of ['bfs', 'dfs', 'jfs', 'star']) {
  const rs = runs.filter((r) => r.size === size && r.algo === algo);
  summary.push({
    size, algo, runs: rs.length,
    successRate: mean(rs.map((r) => (r.found ? 1 : 0))),
    optimality: mean(rs.filter((r) => r.found).map((r) => r.optimality)),
    visited: mean(rs.map((r) => r.visited)),
    jevCalls: mean(rs.map((r) => r.jevCalls)),
    elapsedMs: mean(rs.map((r) => r.elapsedMs)),
    costUsd: mean(rs.map((r) => r.costUsd)),
    probability: mean(rs.filter((r) => r.found).map((r) => r.probability ?? 0)),
  });
}

const bench = { recordedAt: new Date().toISOString(), mock, model, sizes: SIZES, iters: ITERS, runs, summary };
await writeFile('media/bench.json', JSON.stringify(bench, null, 2) + '\n');
try {
  const page = await readFile('media/charts.html', 'utf8');
  const updated = page.replace(/(<script id="bench" type="application\/json">)[\s\S]*?(<\/script>)/, (_, o, c) => `${o}\n${JSON.stringify(bench).replace(/<\//g, '<\\/')}\n${c}`);
  if (updated !== page) await writeFile('media/charts.html', updated);
} catch {}
console.log(`\nwrote media/bench.json (${mock ? 'mock' : model}, ${runs.length} runs)`);
console.table(summary.map((s) => ({ n: s.size, algo: s.algo, found: s.successRate.toFixed(2), optimal: s.optimality.toFixed(2), visited: s.visited.toFixed(1), calls: s.jevCalls.toFixed(1), ms: s.elapsedMs.toFixed(1), usd: s.costUsd.toFixed(6) })));
