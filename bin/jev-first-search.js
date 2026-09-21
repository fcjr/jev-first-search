#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { jevFirstSearch } from '../src/index.js';

const args = process.argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith('--')));
const [file, start, goal] = args.filter((a) => !a.startsWith('--'));

if (!file || !start || !goal) {
  console.error('usage: jev-first-search [--mock] [--no-jev-first] <graph.json> <start> <goal>');
  process.exit(2);
}

const graph = JSON.parse(await readFile(file, 'utf8'));
const options = { jevFirst: !flags.has('--no-jev-first') };
if (flags.has('--mock')) {
  const { MockJev } = await import('../src/mock.js');
  options.client = new MockJev();
}

const bar = (p) => '█'.repeat(Math.round(p * 10)).padEnd(10, '░');
const ms = (n) => `${Math.round(n)}ms`.padStart(6);
let n = 0;

console.log(`jev-first-search  ${start} → ${goal}`);
options.onStep = (step) => {
  if (step.type === 'jev-first') {
    const verdict = step.noul >= 0.5 ? 'ok, searching' : 'no. not searching.';
    console.log(`  jev first  reachable? ${bar(step.noul)} ${step.noul.toFixed(2)}  ${ms(step.ms)}  ${verdict}`);
    return;
  }
  n += 1;
  const frontier = `[${step.frontier.join(', ')}]`.padEnd(24);
  console.log(`  step ${String(n).padStart(2)}    ${frontier} → ${step.picked.padEnd(10)} ${bar(step.confidence)} ${step.confidence.toFixed(2)}  ${ms(step.ms)}`);
};

const result = await jevFirstSearch(graph, start, goal, options);

console.log();
console.log(result.path ? `  path: ${result.path.join(' → ')}  (probably: ${result.probability.toFixed(2)})` : `  no path (${result.reason})`);
console.log(`  ${result.jevCalls} jev call${result.jevCalls === 1 ? '' : 's'} · ${Math.round(result.elapsedMs)} ms · $${result.estimatedCostUsd.toFixed(7)}`);
