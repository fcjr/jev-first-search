#!/usr/bin/env node
// Runs the searches the animations replay and writes down what Jev actually said.
// Output: media/traces.json, inlined into media/race.html and media/terminal.html.
//
//   node scripts/record.js          # real Jev, reads TYPESAFE_API_KEY from .env
//   node scripts/record.js --mock   # no key, made-up answers
import { readFile, writeFile } from 'node:fs/promises';
import { jevFirstSearch, jevStar } from '../src/index.js';

const mock = process.argv.includes('--mock');
try { process.loadEnvFile('.env'); } catch {}

let client;
if (mock) {
  const { MockJev } = await import('../src/mock.js');
  client = new MockJev();
} else {
  if (!process.env.TYPESAFE_API_KEY) {
    console.error('TYPESAFE_API_KEY is not set. Put it in .env, or run with --mock.');
    process.exit(1);
  }
  const { TypeSafeClient } = await import('@typesafe-ai/sdk');
  client = new TypeSafeClient({ retry: { maxRetries: 0 } });
}

let model = null;
const recorder = {
  async systemOne(request) {
    const result = await client.systemOne(request);
    model = result.model;
    return result;
  },
};

const graph = async (file) => JSON.parse(await readFile(file, 'utf8'));
const log = (label) => (step) => {
  if (step.type === 'jev-first') console.log(`  ${label}: jev first → ${step.noul.toFixed(2)} (${Math.round(step.ms)}ms)`);
  else if (step.type === 'visit') console.log(`  ${label}: → ${step.picked} (${step.confidence.toFixed(2)}, ${Math.round(step.ms)}ms)`);
  else if (step.type === 'heuristic') console.log(`  ${label}: h(${step.node}) = ${step.h.toFixed(2)} (${Math.round(step.ms)}ms)`);
};

const race = await graph('examples/race.json');
console.log('race: A → H');
const jfs = await jevFirstSearch(race, 'A', 'H', { client: recorder, onStep: log('jfs') });
console.log(`  jfs: ${jfs.path ? jfs.path.join(' → ') : `no path (${jfs.reason})`}`);
const star = await jevStar(race, 'A', 'H', { client: recorder, onStep: log('jev*') });
console.log(`  jev*: ${star.path ? star.path.join(' → ') : `no path (${star.reason})`}`);

const office = await graph('examples/office.json');
const terminal = [];
for (const [start, goal] of [['desk', 'coffee'], ['desk', 'parking_lot'], ['desk', 'roof']]) {
  console.log(`terminal: ${start} → ${goal}`);
  const result = await jevFirstSearch(office, start, goal, { client: recorder, onStep: log('jfs') });
  console.log(`  ${result.path ? result.path.join(' → ') : `no path (${result.reason})`}`);
  terminal.push({ args: ['examples/office.json', start, goal], result });
}

const traces = {
  recordedAt: new Date().toISOString(),
  mock,
  model,
  race: { graph: race, start: 'A', goal: 'H', jfs, jevStar: star },
  terminal,
};
const json = JSON.stringify(traces);
await writeFile('media/traces.json', JSON.stringify(traces, null, 2) + '\n');

for (const page of ['media/race.html', 'media/terminal.html']) {
  const html = await readFile(page, 'utf8');
  const updated = html.replace(
    /(<script id="traces" type="application\/json">)[\s\S]*?(<\/script>)/,
    (_, open, close) => `${open}\n${json.replace(/<\//g, '<\\/')}\n${close}`,
  );
  if (updated === html) throw new Error(`${page} has no traces block`);
  await writeFile(page, updated);
}
console.log(`\nwrote media/traces.json (${mock ? 'mock' : model}) and updated the pages`);
