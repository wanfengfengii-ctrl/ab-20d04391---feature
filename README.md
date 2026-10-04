# PCR Pool Allocator

Multiplex-PCR panel pre-finalization service. It partitions 8–18 amplicons into
2–4 parallel reaction pools with exact (branch-and-bound) optimization — not a
greedy placement — so high-risk dimer pairs and positive-control loss cannot be
left behind by a locally reasonable but globally suboptimal assignment.

## What it guarantees

Every amplicon is assigned to exactly one pool. Hard constraints:

- each pool contains **at least one positive control**;
- each pool load lies inside the uniform inclusive interval `[loadRange.min, loadRange.max]`;
- a listed pair whose risk reaches `hardThreshold` is **never** co-located
  (unlisted pairs are treated as risk 0).

Among all feasible allocations the solver minimizes, strictly in this order:

1. the largest single-pool risk sum;
2. the sum of risk over all pools;
3. the load spread (heaviest pool load − lightest pool load);
4. the pool-number sequence flattened in amplicon recording order
   (1-based; gives one canonical, stable allocation).

The search is exhaustive (MRV + forward checking + Hall matching for controls +
subset-sum reachability + pool symmetry elimination), so `feasible: false`
proves that no allocation exists.

## Run

```bash
# host port comes from APP_PORT (default 3000)
APP_PORT=8080 docker compose up -d --build app
curl -s http://localhost:8080/health
```

### One-shot verification service

```bash
docker compose run --rm verify
```

`verify` performs, by itself, and then exits with a bit-mask code:

1. TypeScript build (`tsc`),
2. the `node:test` suite,
3. wait for the app's `/health` endpoint,
4. live API checks including a **non-greedy trap** (the greedy "emptiest pool"
   layout realizes risk 7 per pool; the service must return the exact risk-0,
   perfectly balanced allocation, independently re-verified), a
   **pre-installed position** scenario (pinning one amplicon reshuffles the
   optimal allocation while the optimum stays reachable, and pre-installed
   hard-constraint violations are reported with members, pool and rule),
   invalid-input field localization and legal-but-infeasible conflict
   summaries.

Exit mask: `1` build, `2` tests, `4` health, `8` API — `0` means all passed.

Local (without Docker):

```bash
npm install
npm run build
npm test
APP_PORT=3000 node dist/src/server.js
# in another shell:
APP_URL=http://127.0.0.1:3000 VERIFY_CWD=$PWD node scripts/verify.mjs
```

## API

### `POST /api/pools/allocate`

```json
{
  "amplicons": [
    { "name": "X", "load": 30, "isControl": false },
    { "name": "c1", "load": 10, "isControl": true }
  ],
  "poolCount": 3,
  "loadRange": { "min": 60, "max": 80 },
  "riskPairs": [
    { "a": "X", "b": "Y", "risk": 9 }
  ],
  "hardThreshold": 9
}
```

| field | rules |
| --- | --- |
| `amplicons` | 8–18 unique non-empty names; `load` positive integer; `isControl` boolean |
| `poolCount` | integer 2–4 |
| `loadRange` | positive integers, `min <= max` |
| `riskPairs` | unordered pairs of known, distinct names; `risk` non-negative integer; no duplicates |
| `hardThreshold` | non-negative integer; a listed pair with `risk >= hardThreshold` is forbidden |
| `preassignments` | *optional*; 1–4 entries, each a known amplicon name and its 1-based pool number; each amplicon at most once |

`preassignments` models amplicons the lab has already loaded into fixed pool
positions before automatic planning. Those positions are immovable: the
pre-installed amplicons still count toward per-pool controls, loads, hard
forbidden pairs and risk statistics, only the remaining amplicons are
allocated, and the same four-level adjudication (largest single-pool risk,
total risk, load spread, then the pool-number sequence in recording order) is
applied. Omitting the field leaves every response unchanged. If a
pre-installed position already violates a hard constraint — a forbidden pair
pinned into one pool, or a pre-installed load exceeding the pool capacity —
the request is reported infeasible and the conflict summary lists the
involved members, the pool number and the violated rule:

```json
{
  "feasible": false,
  "conflictSummary": {
    "forbiddenPairs": [],
    "overCapacityClique": [],
    "preassignmentConflicts": [
      { "members": ["X", "Y"], "pool": 1, "rule": "forbidden pair (risk 9 reaches the hard threshold) pre-installed in the same pool" }
    ]
  }
}
```

Success (`200`):

```json
{
  "feasible": true,
  "poolCount": 3,
  "pools": [
    {
      "pool": 1,
      "members": ["X", "c1", "d"],
      "load": 70,
      "controls": ["c1"],
      "riskPairs": [],
      "riskSum": 0
    }
  ],
  "maxPoolRisk": 0,
  "totalRisk": 0,
  "loadSpread": 0,
  "assignment": [{ "amplicon": "X", "pool": 1 }]
}
```

Invalid input (`400`) pinpoints fields, including array indices:

```json
{
  "error": "validation_failed",
  "issues": [
    { "field": "amplicons[5].load", "message": "must be a positive integer" },
    { "field": "riskPairs[0].b", "message": "unknown amplicon name \"GHOST\"" }
  ]
}
```

Legal but unsatisfiable (`200`):

```json
{
  "feasible": false,
  "conflictSummary": {
    "forbiddenPairs": [{ "a": "A0", "b": "A1", "risk": 9 }],
    "overCapacityClique": ["A0", "A1", "A2"],
    "poolsWithoutControl": 2,
    "loadIssue": "..."
  }
}
```

## Layout

```
src/
  types.ts       request/response contracts
  validation.ts  structural validation with field locators
  solver.ts      exact two-phase branch-and-bound
  allocate.ts    instance construction and response assembly
  server.ts      node:http service (/health, /api/pools/allocate)
test/            differential tests vs a brute-force oracle + HTTP tests
scripts/verify.mjs  one-shot verification entry point
```
