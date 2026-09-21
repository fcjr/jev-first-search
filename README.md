# jev-first-search

**Graph search that asks Jev which node to visit next.**

Depth-first search pops a stack. Breadth-first search shifts a queue. Jev-first search makes an HTTP request.

```
npm install jev-first-search
```

## Usage

```js
import { jevFirstSearch } from 'jev-first-search';

const graph = {
  A: ['B', 'C'],
  B: ['A', 'D'],
  C: ['A', 'E'],
  D: ['B', 'F'],
  E: ['C', 'F'],
  F: ['D', 'E'],
};

const result = await jevFirstSearch(graph, 'A', 'F');
console.log(result.path);
// ['A', 'C', 'E', 'F'] (confidence: 0.71)
```

Set `TYPESAFE_API_KEY` before use. Requires Node.js 20+.

## The algorithm

```
JFS(G, s, t):
  if jev("t is reachable from s") < 0.5:       # jev first
      return nothing                            # fastest way to not find something
  frontier ← {s}
  while frontier is not empty:
      v ← jev("which of these next?", frontier ∪ {give_up})
      if v = give_up: return nothing
      if v = t:       return path to t
      frontier ← (frontier \ {v}) ∪ unseen neighbors of v
```

Every iteration is one `POST /v1/systemone`. Jev returns in 70–500 ms, which is faster than most people can decide which node to visit next, so this is arguably an optimization.

## How it compares

| Algorithm | Frontier | Time | Space | Optimal path | Complete |
| --- | --- | --- | --- | --- | --- |
| Breadth-first | queue | O(V + E) | O(V) | yes (unweighted) | yes |
| Depth-first | stack | O(V + E) | O(V) | no | yes |
| Dijkstra | priority queue | O((V + E) log V) | O(V) | yes | yes |
| A* | priority queue + heuristic | depends on h | O(V) | yes (admissible h) | yes |
| **Jev-first** | **Jev** | **O(V × 300 ms)** | **O(V) + $0.042 / M tokens** | **confidence: 0.61** | **Jev may give up** |

## Jev first

Before searching, JFS asks Jev one `noul` question: *is the goal even reachable?* If Jev says no, JFS returns `null` after one API call and zero nodes visited.

```
jev-first-search  desk → parking_lot
  jev first  reachable? █░░░░░░░░░ 0.12   288ms  no. not searching.

  no path (jev said no)
  1 jev call · 288 ms · $0.0000089
```

This saves API calls by making an API call. Pass `{ jevFirst: false }` if you would rather find out the hard way.

## Giving up

Every step, Jev is offered `give_up` alongside the frontier. Jev may take it. Nothing in the algorithm prevents this and nothing in the algorithm should.

```
  step  3    [window, kitchen, stairs]  → give_up    ██████░░░░ 0.58   341ms

  no path (jev gave up)
```

## Jev*

A* needs a heuristic. Jev* gets one over HTTP.

```js
import { jevStar } from 'jev-first-search';

const result = await jevStar(graph, 'A', 'F');
// every node discovered costs one `score` question:
//   "How many edges is node D from node F?"
//   0: It is the goal · 1: One edge · 2: Two edges · 3: Three edges · 4: Four or more
// the expected score is h(n). g(n) is counted locally, like an animal.
```

Admissible? Consistent? Jev reports a confidence with every estimate, which is more than your Manhattan distance ever did.

## CLI

```
npx jev-first-search examples/office.json desk coffee
```

```
jev-first-search  desk → coffee
  jev first  reachable? █████████░ 0.91   387ms  ok, searching
  step  1    [desk]                   → desk       ███████░░░ 0.66   366ms
  step  2    [hallway, window]        → hallway    ████████░░ 0.83   210ms
  step  3    [window, kitchen, meeting_room, stairs] → window     █████████░ 0.88   261ms
  step  4    [kitchen, meeting_room, stairs] → kitchen    ███████░░░ 0.68   353ms
  step  5    [meeting_room, stairs, coffee] → meeting_room ███████░░░ 0.66   128ms
  step  6    [stairs, coffee]         → stairs     ████████░░ 0.81    92ms
  step  7    [coffee, roof]           → coffee     █████████░ 0.94   103ms

  path: desk → hallway → kitchen → coffee
  8 jev calls · 1902 ms · $0.0000232
```

Add `--mock` to run without an API key. The mock always picks the first frontier node, which makes it breadth-first search with a 70–500 ms sleep and a made-up confidence score.

## API

```ts
jevFirstSearch(graph, start, goal, options?) => Promise<{
  path: string[] | null,
  reason: 'found' | 'jev said no' | 'jev gave up' | 'frontier exhausted' | string,
  visited: string[],
  steps: Step[],
  jevCalls: number,
  inputTokens: number,
  elapsedMs: number,
  estimatedCostUsd: number,
}>
```

| Option | Default | |
| --- | --- | --- |
| `client` | `new TypeSafeClient({ retry: { maxRetries: 0 } })` | anything with a `systemOne()` |
| `model` | `'jev-latest'` | |
| `jevFirst` | `true` | ask before searching |
| `onStep` | | called with each step as it happens |

## Limitations

- Graphs may not contain a node named `give_up`.
- Jev is asked even when the frontier has one node. Jev has never picked wrong in this situation, only `give_up`.
- One API request per node visited. Retries are disabled.
- Not deterministic. Not complete. Not optimal. Not free.
- Not suitable for production use.

## FAQ

**Why?**
Jev returns calibrated probabilities in under half a second. Nobody said what the question had to be.

**Is the path optimal?**
Jev is shown the frontier, the visited set, and each node's neighbors. Whether Jev cares is between Jev and the neighbors.

**Does it work on weighted graphs?**
Put the weights in the neighbor list. Jev will see them.

**What does the confidence mean?**
It is a number between 0 and 1.

**Can I use this in production?**
`noul: 0.03`

## Animations

`media/` holds the two animations from the announcement: a four-way race (BFS, DFS, Jev-first, Jev*) and a terminal replay of the CLI. They replay recorded Jev responses, not scripted ones.

```
npm run media:record        # runs the searches against Jev and writes media/traces.json into both pages
npm run media:record:mock   # same, without an API key
npm run media:render        # headless Chrome + ffmpeg → media/race.mp4, media/terminal.mp4
```

Open `media/race.html` or `media/terminal.html` in a browser to watch them loop.

## Development

```
npm install
npm test        # mocked, no API key needed
npm run demo    # runs the office example with the mock
```

## License

MIT
