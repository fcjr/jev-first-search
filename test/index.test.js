import { describe, expect, it } from 'vitest';
import { jevFirstSearch, GIVE_UP } from '../src/index.js';
import { MockJev } from '../src/mock.js';

const graph = {
  A: ['B', 'C'],
  B: ['A', 'D'],
  C: ['A', 'E'],
  D: ['B', 'F'],
  E: ['C', 'F'],
  F: ['D', 'E'],
};

// A scripted Jev: answers in order, no latency, no opinions.
function scripted(answers) {
  const queue = [...answers];
  return {
    calls: [],
    async systemOne(request) {
      this.calls.push(request);
      const next = queue.shift();
      if (!next) throw new Error('script ran out of answers');
      const [name, question] = Object.entries(request.questions)[0];
      const answer =
        question.type === 'noul'
          ? { type: 'noul', noul: next }
          : { type: 'choice', choice: next, confidence: 0.7, probabilities: { [next]: 0.7 } };
      return { model: 'jev-scripted', answers: { [name]: answer }, usage: { input_tokens: 100, output_tokens: 0 } };
    },
  };
}

describe('jevFirstSearch', () => {
  it('finds a path when jev picks well', async () => {
    const client = scripted([0.9, 'A', 'C', 'E', 'F']);
    const result = await jevFirstSearch(graph, 'A', 'F', { client });
    expect(result.path).toEqual(['A', 'C', 'E', 'F']);
    expect(result.reason).toBe('found');
    expect(result.jevCalls).toBe(5);
    expect(result.estimatedCostUsd).toBeCloseTo(500 * 0.042e-6, 12);
    expect(result.probability).toBeCloseTo(0.9 * 0.7 ** 4, 10);
  });

  it('has no probability when there is no path', async () => {
    const result = await jevFirstSearch(graph, 'A', 'F', { client: scripted([0.12]) });
    expect(result.probability).toBe(0);
  });

  it('asks jev first and skips the search when jev says no', async () => {
    const client = scripted([0.12]);
    const result = await jevFirstSearch(graph, 'A', 'F', { client });
    expect(result.path).toBeNull();
    expect(result.reason).toBe('jev said no');
    expect(result.visited).toEqual([]);
    expect(result.jevCalls).toBe(1);
  });

  it('can skip the jev-first step', async () => {
    const client = scripted(['A', 'B', 'D', 'F']);
    const result = await jevFirstSearch(graph, 'A', 'F', { client, jevFirst: false });
    expect(result.path).toEqual(['A', 'B', 'D', 'F']);
    expect(client.calls[0].questions.next.type).toBe('choice');
  });

  it('returns null when jev gives up', async () => {
    const client = scripted([0.8, 'A', GIVE_UP]);
    const result = await jevFirstSearch(graph, 'A', 'F', { client });
    expect(result.path).toBeNull();
    expect(result.reason).toBe('jev gave up');
    expect(result.visited).toEqual(['A']);
  });

  it('always offers jev the option to give up', async () => {
    const client = scripted(['A', 'B', 'D', 'F']);
    await jevFirstSearch(graph, 'A', 'F', { client, jevFirst: false });
    for (const call of client.calls) {
      expect(Object.keys(call.questions.next.criteria)).toContain(GIVE_UP);
    }
  });

  it('only offers frontier nodes', async () => {
    const client = scripted(['A', 'C']);
    await jevFirstSearch(graph, 'A', 'E', { client, jevFirst: false }).catch(() => {});
    expect(Object.keys(client.calls[1].questions.next.criteria)).toEqual(['B', 'C', GIVE_UP]);
  });

  it('reports every step', async () => {
    const client = scripted([0.9, 'A', 'B']);
    const steps = [];
    await jevFirstSearch(graph, 'A', 'B', { client, onStep: (s) => steps.push(s) });
    expect(steps.map((s) => s.type)).toEqual(['jev-first', 'visit', 'visit']);
    expect(steps[2].picked).toBe('B');
  });

  it('rejects graphs with a give_up node', async () => {
    await expect(jevFirstSearch({ give_up: [] }, 'give_up', 'give_up', { client: scripted([]) })).rejects.toThrow(
      /give_up/,
    );
  });

  it('rejects unknown nodes', async () => {
    await expect(jevFirstSearch(graph, 'A', 'Z', { client: scripted([]) })).rejects.toThrow(/unknown goal/);
  });

  it('works with the mock', async () => {
    const result = await jevFirstSearch(graph, 'A', 'F', { client: new MockJev({ latency: false }) });
    expect(result.path).toEqual(['A', 'B', 'D', 'F']);
  });

  it('the mock can give up too', async () => {
    const result = await jevFirstSearch(graph, 'A', 'F', {
      client: new MockJev({ latency: false, giveUpAfter: 2 }),
    });
    expect(result.reason).toBe('jev gave up');
  });
});

describe('jevStar', async () => {
  const { jevStar } = await import('../src/star.js');

  // A Jev that happens to know the true distance to F.
  const truth = { A: 3, B: 2, C: 2, D: 1, E: 1, F: 0 };
  const oracle = {
    calls: 0,
    async systemOne({ state }) {
      this.calls += 1;
      const value = truth[state.node];
      return {
        model: 'jev-oracle',
        answers: { distance: { type: 'score', score: value, confidence: 0.9, legend: {}, probabilities: { [value]: 1 } } },
        usage: { input_tokens: 120, output_tokens: 0 },
      };
    },
  };

  it('finds the shortest path with a perfect heuristic', async () => {
    oracle.calls = 0;
    const result = await jevStar(graph, 'A', 'F', { client: oracle });
    expect(result.path).toHaveLength(4);
    expect(result.path[0]).toBe('A');
    expect(result.path.at(-1)).toBe('F');
    expect(result.reason).toBe('found');
    expect(result.jevCalls).toBe(oracle.calls);
  });

  it('asks jev once per discovered node', async () => {
    oracle.calls = 0;
    const result = await jevStar(graph, 'A', 'F', { client: oracle });
    expect(oracle.calls).toBe(Object.keys(result.heuristics).length);
  });

  it('records heuristic and expand steps', async () => {
    const result = await jevStar(graph, 'A', 'B', { client: oracle });
    expect(result.steps[0]).toMatchObject({ type: 'heuristic', node: 'A' });
    expect(result.steps.some((s) => s.type === 'expand' && s.node === 'A')).toBe(true);
  });

  it('works with the mock', async () => {
    const result = await jevStar(graph, 'A', 'F', { client: new MockJev({ latency: false }) });
    expect(result.reason).toBe('found');
  });
});
