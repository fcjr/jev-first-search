import { choice, noul, TypeSafeClient } from '@typesafe-ai/sdk';

export const GIVE_UP = 'give_up';

// docs.typesafe.ai/models: $0.042 per million input tokens, output is free.
const USD_PER_INPUT_TOKEN = 0.042 / 1_000_000;

/**
 * Search `graph` for a path from `start` to `goal`.
 *
 * DFS pops a stack. BFS shifts a queue. JFS asks Jev.
 *
 * @param {Record<string, string[]>} graph adjacency list
 * @param {string} start
 * @param {string} goal
 * @param {object} [options]
 * @param {import('@typesafe-ai/sdk').TypeSafeClient} [options.client]
 * @param {string} [options.model='jev-latest']
 * @param {boolean} [options.jevFirst=true] ask Jev whether to bother before searching
 * @param {(step: object) => void} [options.onStep]
 */
export async function jevFirstSearch(graph, start, goal, options = {}) {
  const {
    client = new TypeSafeClient({ retry: { maxRetries: 0 } }),
    model = 'jev-latest',
    jevFirst = true,
    onStep = () => {},
  } = options;

  if (!(start in graph)) throw new RangeError(`unknown start node: ${start}`);
  if (!(goal in graph)) throw new RangeError(`unknown goal node: ${goal}`);
  if (GIVE_UP in graph) throw new RangeError(`graphs may not contain a node named ${GIVE_UP}`);

  const t0 = performance.now();
  const visited = [];
  const steps = [];
  let jevCalls = 0;
  let inputTokens = 0;

  const ask = async (state, questions) => {
    const t = performance.now();
    const result = await client.systemOne({ model, state, questions });
    jevCalls += 1;
    inputTokens += result.usage?.input_tokens ?? 0;
    return { answers: result.answers, ms: performance.now() - t };
  };

  // The product of Jev's confidence at every step. "Probably" has a number now.
  const probability = () =>
    steps.reduce((p, s) => p * (s.type === 'jev-first' ? s.noul : s.confidence), 1);

  const finish = (path, reason) => ({
    path,
    reason,
    probability: path ? probability() : 0,
    visited,
    steps,
    jevCalls,
    inputTokens,
    elapsedMs: performance.now() - t0,
    estimatedCostUsd: inputTokens * USD_PER_INPUT_TOKEN,
  });

  // Jev first. Then search.
  if (jevFirst) {
    const { answers, ms } = await ask(
      { graph, start, goal },
      { reachable: noul(`There is a path from node "${start}" to node "${goal}" in this graph.`) },
    );
    const step = { type: 'jev-first', noul: answers.reachable.noul, ms };
    steps.push(step);
    onStep(step);
    if (answers.reachable.noul < 0.5) return finish(null, 'jev said no');
  }

  const parent = new Map([[start, null]]);
  let frontier = [start];

  while (frontier.length > 0) {
    const criteria = Object.fromEntries(
      frontier.map((node) => [node, { via: parent.get(node), neighbors: graph[node] ?? [] }]),
    );
    criteria[GIVE_UP] = 'Stop searching. The goal is not worth it.';

    const { answers, ms } = await ask(
      { goal, visited, frontier },
      { next: choice('Which frontier node should be visited next to reach the goal?', criteria) },
    );
    const { choice: picked, confidence, probabilities } = answers.next;

    const step = { type: 'visit', frontier: [...frontier], picked, confidence, probabilities, ms };
    steps.push(step);
    onStep(step);

    if (picked === GIVE_UP) return finish(null, 'jev gave up');
    if (!frontier.includes(picked)) return finish(null, `jev picked "${picked}", which is not on the frontier`);

    visited.push(picked);
    if (picked === goal) return finish(pathTo(parent, goal), 'found');

    frontier = frontier.filter((node) => node !== picked);
    for (const neighbor of graph[picked] ?? []) {
      if (!parent.has(neighbor)) {
        parent.set(neighbor, picked);
        frontier.push(neighbor);
      }
    }
  }

  return finish(null, 'frontier exhausted');
}

function pathTo(parent, node) {
  const path = [];
  for (let cursor = node; cursor !== null; cursor = parent.get(cursor)) path.unshift(cursor);
  return path;
}

export default jevFirstSearch;

export { jevStar, DISTANCE_RUBRIC } from './star.js';
