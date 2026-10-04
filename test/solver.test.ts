import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildInstance, allocate } from '../src/allocate.js';
import { solve, type SolverInstance } from '../src/solver.js';
import type { AllocateRequest } from '../src/types.js';

/* ----------------------------- brute-force oracle ----------------------------- */

interface OracleResult {
  assignment: number[];
  maxRisk: number;
  totalRisk: number;
  spread: number;
}

function oracle(inst: SolverInstance): OracleResult | null {
  const { n, k, loads, isControl, risk, forbidden, minLoad, maxLoad } = inst;
  let best: OracleResult | null = null;

  const assign = new Array<number>(n).fill(0);
  const enumerate = (u: number): void => {
    if (u === n) {
      const pl = new Array<number>(k).fill(0);
      const pr = new Array<number>(k).fill(0);
      const pc = new Array<number>(k).fill(0);
      const used = new Array<boolean>(k).fill(false);
      for (let i = 0; i < n; i++) {
        const j = assign[i]!;
        pl[j]! += loads[i]!;
        pc[j]! += isControl[i] ? 1 : 0;
        used[j] = true;
        for (let w = 0; w < i; w++) {
          if (assign[w] === j) pr[j]! += risk[i * n + w]!;
        }
      }
      for (let j = 0; j < k; j++) {
        if (!used[j] || pl[j]! < minLoad || pl[j]! > maxLoad || pc[j] === 0) return;
        for (let i = 0; i < n; i++) {
          if (assign[i] !== j) continue;
          for (let w = i + 1; w < n; w++) {
            if (assign[w] === j && forbidden[i * n + w]) return;
          }
        }
      }
      const maxRisk = Math.max(...pr);
      const totalRisk = pr.reduce((a, b) => a + b, 0);
      const spread = Math.max(...pl) - Math.min(...pl);
      const cand: OracleResult = { assignment: [...assign], maxRisk, totalRisk, spread };
      if (
        best === null ||
        cand.maxRisk < best.maxRisk ||
        (cand.maxRisk === best.maxRisk && cand.totalRisk < best.totalRisk) ||
        (cand.maxRisk === best.maxRisk &&
          cand.totalRisk === best.totalRisk &&
          cand.spread < best.spread) ||
        (cand.maxRisk === best.maxRisk &&
          cand.totalRisk === best.totalRisk &&
          cand.spread === best.spread &&
          lex(cand.assignment, best.assignment) < 0)
      ) {
        best = cand;
      }
      return;
    }
    for (let j = 0; j < k; j++) {
      assign[u] = j;
      enumerate(u + 1);
    }
  };
  enumerate(0);
  return best;
}

function lex(a: number[], b: number[]): number {
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return a[i]! - b[i]!;
  }
  return 0;
}

function makeRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

/* ------------------------- random differential testing ------------------------- */

test('solver matches brute-force oracle on random small instances', () => {
  const rng = makeRng(20261002);
  let feasibleCount = 0;
  for (let t = 0; t < 400; t++) {
    const n = 4 + Math.floor(rng() * 5); // 4..8
    const k = 2 + Math.floor(rng() * 2); // 2..3
    const names = Array.from({ length: n }, (_, i) => `A${i}`);
    const loads = Array.from({ length: n }, () => 1 + Math.floor(rng() * 6));
    const isControl = Array.from({ length: n }, () => rng() < 0.45);
    if (!isControl.some(Boolean)) isControl[0] = true;
    const total = loads.reduce((a, b) => a + b, 0);
    const minLoad = 1 + Math.floor(rng() * Math.min(4, Math.floor(total / k)));
    const maxLoad = Math.max(minLoad, Math.floor(total / k) + Math.floor(rng() * 8));
    const threshold = 5;
    const riskPairs: { a: string; b: string; risk: number }[] = [];
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        if (rng() < 0.45) {
          const r = rng() < 0.25
            ? threshold + Math.floor(rng() * 4) // hard forbidden
            : 1 + Math.floor(rng() * (threshold - 1));
          riskPairs.push({ a: names[i]!, b: names[j]!, risk: r });
        }
      }
    }
    const req: AllocateRequest = {
      amplicons: names.map((name, i) => ({ name, load: loads[i]!, isControl: isControl[i]! })),
      poolCount: k,
      loadRange: { min: minLoad, max: maxLoad },
      riskPairs,
      hardThreshold: threshold,
    };
    const inst = buildInstance(req);
    const expected = oracle(inst);
    const actual = solve(inst);
    if (expected === null) {
      assert.equal(actual, null, `case ${t}: solver should report infeasible`);
    } else {
      feasibleCount++;
      assert.ok(actual, `case ${t}: solver should find a solution`);
      assert.deepEqual(
        [actual!.maxRisk, actual!.totalRisk, actual!.spread, actual!.assignment],
        [expected.maxRisk, expected.totalRisk, expected.spread, expected.assignment],
        `case ${t}: objective mismatch`,
      );
    }
  }
  assert.ok(feasibleCount > 50, `expected many feasible random cases, got ${feasibleCount}`);
});

/* ----------------------------- hard-constraint checks ----------------------------- */

function assertHardConstraints(req: AllocateRequest) {
  const res = allocate(req);
  assert.equal(res.feasible, true);
  const assigned = new Map<string, number>();
  res.pools!.forEach((p) => p.members.forEach((m) => assigned.set(m, p.pool)));
  assert.equal(assigned.size, req.amplicons.length, 'every amplicon assigned exactly once');
  for (const p of res.pools!) {
    assert.ok(p.load >= req.loadRange.min && p.load <= req.loadRange.max, 'load in range');
    assert.ok(p.controls.length >= 1, 'every pool has a control');
    for (const rp of p.riskPairs) assert.ok(rp.risk < req.hardThreshold, 'no forbidden pair co-located');
  }
  for (const rp of req.riskPairs) {
    if (rp.risk >= req.hardThreshold) {
      assert.notEqual(assigned.get(rp.a), assigned.get(rp.b), 'forbidden pair separated');
    }
  }
  return res;
}

/* ------------------------------- non-greedy trap -------------------------------- */

// A naive greedy ("place each amplicon into the currently emptiest pool")
// builds a feasible but suboptimal layout: a lands with X, b with Y, d with Z,
// realising risk 7 in every pool. The exact optimum deranges the items so that
// zero listed risk is realised. The trap proves backtracking is mandatory; the
// greedy answer is a stable-but-wrong answer that must not be returned.
test('non-greedy trap: greedy is feasible but suboptimal, exact solver hits risk 0', () => {
  const amplicons = [
    { name: 'X', load: 30, isControl: false },
    { name: 'Y', load: 30, isControl: false },
    { name: 'Z', load: 30, isControl: false },
    { name: 'c1', load: 10, isControl: true },
    { name: 'c2', load: 10, isControl: true },
    { name: 'c3', load: 10, isControl: true },
    { name: 'a', load: 30, isControl: false },
    { name: 'b', load: 30, isControl: false },
    { name: 'd', load: 30, isControl: false },
  ];
  const riskPairs = [
    { a: 'X', b: 'Y', risk: 9 },
    { a: 'X', b: 'Z', risk: 9 },
    { a: 'Y', b: 'Z', risk: 9 },
    { a: 'a', b: 'X', risk: 7 },
    { a: 'b', b: 'Y', risk: 7 },
    { a: 'd', b: 'Z', risk: 7 },
  ];
  const req: AllocateRequest = {
    amplicons,
    poolCount: 3,
    loadRange: { min: 60, max: 80 },
    riskPairs,
    hardThreshold: 9,
  };
  const res = assertHardConstraints(req);

  // Every pool is forced to anchor(30) + control(10) + one heavy item(30) = 70.
  const greedyAssignment = simulateGreedy(req);
  assert.ok(greedyAssignment, 'greedy finds a feasible layout');
  assert.equal(maxRiskOf(req, greedyAssignment!), 7, 'greedy leaves risk-7 pairs co-located');

  // Exact optimum deranges a/b/d away from X/Y/Z: no listed soft risk at all.
  assert.equal(res.maxPoolRisk, 0);
  assert.equal(res.totalRisk, 0);
  assert.equal(res.loadSpread, 0);
});

function simulateGreedy(req: AllocateRequest): number[] | null {
  const k = req.poolCount;
  const loads = new Array<number>(k).fill(0);
  const controls = new Array<number>(k).fill(0);
  const members: string[][] = Array.from({ length: k }, () => []);
  const riskOf = new Map<string, number>();
  for (const rp of req.riskPairs) {
    riskOf.set(rp.a < rp.b ? `${rp.a}|${rp.b}` : `${rp.b}|${rp.a}`, rp.risk);
  }
  const assignment: number[] = [];
  for (const amp of req.amplicons) {
    let chosen = -1;
    for (let j = 0; j < k; j++) {
      const fits = loads[j]! + amp.load <= req.loadRange.max;
      const ok = members[j]!.every((m) => {
        const key = m < amp.name ? `${m}|${amp.name}` : `${amp.name}|${m}`;
        return (riskOf.get(key) ?? 0) < req.hardThreshold;
      });
      if (fits && ok && (chosen === -1 || loads[j]! < loads[chosen]!)) chosen = j;
    }
    if (chosen === -1) return null;
    loads[chosen]! += amp.load;
    controls[chosen]! += amp.isControl ? 1 : 0;
    members[chosen]!.push(amp.name);
    assignment.push(chosen + 1);
  }
  for (let j = 0; j < k; j++) {
    if (loads[j]! < req.loadRange.min || controls[j] === 0) return null;
  }
  return assignment;
}

function maxRiskOf(req: AllocateRequest, assignment: number[]): number {
  const riskOf = new Map<string, number>();
  for (const rp of req.riskPairs) {
    riskOf.set(rp.a < rp.b ? `${rp.a}|${rp.b}` : `${rp.b}|${rp.a}`, rp.risk);
  }
  const sums = new Array<number>(req.poolCount).fill(0);
  for (let i = 0; i < assignment.length; i++) {
    for (let w = 0; w < i; w++) {
      if (assignment[i] === assignment[w]) {
        const ni = req.amplicons[i]!.name;
        const nw = req.amplicons[w]!.name;
        const key = ni < nw ? `${ni}|${nw}` : `${nw}|${ni}`;
        sums[assignment[i]! - 1]! += riskOf.get(key) ?? 0;
      }
    }
  }
  return Math.max(...sums);
}

/* ------------------------------- lex tie-break -------------------------------- */

test('lexicographic tie-break is applied after the three numeric objectives', () => {
  // Fully symmetric: zero risk everywhere, balanced loads -> earliest pools
  // in amplicon recording order win.
  const amplicons = Array.from({ length: 8 }, (_, i) => ({
    name: `S${i}`,
    load: 10,
    isControl: i % 2 === 0,
  }));
  const req: AllocateRequest = {
    amplicons,
    poolCount: 2,
    loadRange: { min: 30, max: 50 },
    riskPairs: [],
    hardThreshold: 5,
  };
  const res = assertHardConstraints(req);
  assert.equal(res.maxPoolRisk, 0);
  // The globally lexicographically smallest valid balanced sequence.
  assert.deepEqual(
    res.assignment!.map((a) => a.pool),
    [1, 1, 1, 1, 2, 2, 2, 2],
  );
});

/* ------------------------------- infeasibility -------------------------------- */

test('infeasible: fewer controls than pools', () => {
  const req: AllocateRequest = {
    amplicons: Array.from({ length: 8 }, (_, i) => ({
      name: `A${i}`,
      load: 10,
      isControl: i === 0,
    })),
    poolCount: 3,
    loadRange: { min: 10, max: 400 },
    riskPairs: [],
    hardThreshold: 5,
  };
  const res = allocate(req);
  assert.equal(res.feasible, false);
  assert.equal(res.conflictSummary!.poolsWithoutControl, 2);
});

test('infeasible: forbidden clique larger than pool count', () => {
  const amplicons = Array.from({ length: 8 }, (_, i) => ({
    name: `A${i}`,
    load: 10,
    isControl: true,
  }));
  const req: AllocateRequest = {
    amplicons,
    poolCount: 2,
    loadRange: { min: 10, max: 400 },
    riskPairs: [
      { a: 'A0', b: 'A1', risk: 9 },
      { a: 'A0', b: 'A2', risk: 9 },
      { a: 'A1', b: 'A2', risk: 9 },
    ],
    hardThreshold: 9,
  };
  const res = allocate(req);
  assert.equal(res.feasible, false);
  assert.deepEqual(new Set(res.conflictSummary!.overCapacityClique), new Set(['A0', 'A1', 'A2']));
});

test('infeasible: indivisible loads make the exact window unreachable', () => {
  // Total load (150) passes every static aggregate check for 2 pools, but no
  // subset sums to 75 (all pieces are even while 75 is odd), so no partition
  // can put both pools in [75,75]. Only exhaustive search proves this.
  const req: AllocateRequest = {
    amplicons: [
      { name: 'P', load: 40, isControl: true },
      { name: 'Q', load: 40, isControl: true },
      { name: 'r1', load: 28, isControl: false },
      { name: 'r2', load: 28, isControl: false },
      { name: 'r3', load: 4, isControl: true },
      { name: 'r4', load: 4, isControl: true },
      { name: 'r5', load: 4, isControl: false },
      { name: 'r6', load: 2, isControl: false },
    ],
    poolCount: 2,
    loadRange: { min: 75, max: 75 },
    riskPairs: [],
    hardThreshold: 5,
  };
  // Guard the premise: 75 must not be a subset sum.
  const pieces = req.amplicons.map((a) => a.load);
  let reach = new Set<number>([0]);
  for (const w of pieces) {
    const next = new Set<number>(reach);
    for (const s of reach) next.add(s + w);
    reach = next;
  }
  assert.equal(reach.has(75), false, 'test premise: no subset sums to 75');
  assert.equal(pieces.reduce((a, b) => a + b, 0), 150);

  const res = allocate(req);
  assert.equal(res.feasible, false);
});

test('infeasible: non-2-colorable forbidden graph (5-cycle) with tight loads', () => {
  // An odd cycle cannot be split across 2 pools. Controls abound and every
  // static load bound passes; only graph search reveals the obstruction.
  const names = ['v0', 'v1', 'v2', 'v3', 'v4', 'w0', 'w1', 'w2'];
  const req: AllocateRequest = {
    amplicons: names.map((name) => ({ name, load: 10, isControl: true })),
    poolCount: 2,
    loadRange: { min: 30, max: 50 },
    riskPairs: [
      { a: 'v0', b: 'v1', risk: 9 },
      { a: 'v1', b: 'v2', risk: 9 },
      { a: 'v2', b: 'v3', risk: 9 },
      { a: 'v3', b: 'v4', risk: 9 },
      { a: 'v4', b: 'v0', risk: 9 },
    ],
    hardThreshold: 9,
  };
  const res = allocate(req);
  assert.equal(res.feasible, false);
});
