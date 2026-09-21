import { score, TypeSafeClient } from '@typesafe-ai/sdk';

const USD_PER_INPUT_TOKEN = 0.042 / 1_000_000;

export const DISTANCE_RUBRIC = [
  'It is the goal',
  'One edge from the goal',
  'Two edges from the goal',
  'Three edges from the goal',
  'Four or more edges from the goal',
];

/**
 * A* where the heuristic is an HTTP request.
 *
 * Every node discovered costs one Jev `score` question: how far is it from the goal?
 * The answer is used as h(n). Whether it is admissible is between Jev and the graph.
 */
export async function jevStar(graph, start, goal, options = {}) {
  const {
    client = new TypeSafeClient({ retry: { maxRetries: 0 } }),
    model = 'jev-latest',
    onStep = () => {},
  } = options;

  if (!(start in graph)) throw new RangeError(`unknown start node: ${start}`);
  if (!(goal in graph)) throw new RangeError(`unknown goal node: ${goal}`);

  const t0 = performance.now();
  const visited = [];
  const steps = [];
  const h = new Map();
  let jevCalls = 0;
  let inputTokens = 0;

  const finish = (path, reason) => ({
    path,
    reason,
    visited,
    steps,
    heuristics: Object.fromEntries(h),
    jevCalls,
    inputTokens,
    elapsedMs: performance.now() - t0,
    estimatedCostUsd: inputTokens * USD_PER_INPUT_TOKEN,
  });

  const heuristic = async (node) => {
    if (h.has(node)) return h.get(node);
    const t = performance.now();
    const result = await client.systemOne({
      model,
      state: { graph, node, goal },
      questions: { distance: score(`How many edges is node "${node}" from node "${goal}"?`, DISTANCE_RUBRIC) },
    });
    jevCalls += 1;
    inputTokens += result.usage?.input_tokens ?? 0;
    const { score: estimate, confidence, probabilities } = result.answers.distance;
    h.set(node, estimate);
    const step = { type: 'heuristic', node, h: estimate, confidence, probabilities, ms: performance.now() - t };
    steps.push(step);
    onStep(step);
    return estimate;
  };

  const g = new Map([[start, 0]]);
  const parent = new Map([[start, null]]);
  const closed = new Set();
  let open = [start];
  await heuristic(start);

  while (open.length > 0) {
    open.sort((a, b) => g.get(a) + h.get(a) - (g.get(b) + h.get(b)));
    const node = open.shift();
    closed.add(node);
    visited.push(node);

    if (node === goal) {
      const step = { type: 'expand', node, g: g.get(node), h: h.get(node), open: [] };
      steps.push(step);
      onStep(step);
      return finish(pathTo(parent, goal), 'found');
    }

    for (const neighbor of graph[node] ?? []) {
      const tentative = g.get(node) + 1;
      if (closed.has(neighbor)) continue;
      if (!g.has(neighbor) || tentative < g.get(neighbor)) {
        g.set(neighbor, tentative);
        parent.set(neighbor, node);
        if (!open.includes(neighbor)) {
          await heuristic(neighbor);
          open.push(neighbor);
        }
      }
    }

    const step = {
      type: 'expand',
      node,
      g: g.get(node),
      h: h.get(node),
      open: open.map((n) => ({ node: n, g: g.get(n), h: h.get(n), f: g.get(n) + h.get(n) })),
    };
    steps.push(step);
    onStep(step);
  }

  return finish(null, 'open set exhausted');
}

function pathTo(parent, node) {
  const path = [];
  for (let cursor = node; cursor !== null; cursor = parent.get(cursor)) path.unshift(cursor);
  return path;
}
