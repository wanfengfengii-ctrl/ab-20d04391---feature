import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildInstance, allocate } from '../src/allocate.js';
import { solve, type SolverInstance, type SolverSolution } from '../src/solver.js';
import type { AllocateRequest } from '../src/types.js';

/* --------------------- fixed-aware brute-force oracle --------------------- */

interface OracleCand {
  assignment: number[];
  maxRisk: number;
  totalRisk: number;
  spread: number;
}

function fixedOracle(inst: SolverInstance): OracleCand | null {
  const { n, k, loads, isControl, risk, forbidden, minLoad, maxLoad, fixed } = inst;
  let best: OracleCand | null = null;
  const assign = new Array<number>(n).fill(0);

  const lex = (a: number[], b: number[]): number => {
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i]! - b[i]!;
    return 0;
  };

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
        for (let w = 0; w < i; w++) if (assign[w] === j) pr[j]! += risk[i * n + w]!;
      }
      for (let j = 0; j < k; j++) {
        if (!used[j] || pl[j]! < minLoad || pl[j]! > maxLoad || pc[j] === 0) return;
        for (let i = 0; i < n; i++) {
          if (assign[i] !== j) continue;
          for (let w = i + 1; w < n; w++) if (assign[w] === j && forbidden[i * n + w]) return;
        }
      }
      const cand = {
        assignment: [...assign],
        maxRisk: Math.max(...pr),
        totalRisk: pr.reduce((a, b) => a + b, 0),
        spread: Math.max(...pl) - Math.min(...pl),
      };
      if (
        best === null ||
        cand.maxRisk < best.maxRisk ||
        (cand.maxRisk === best.maxRisk && cand.totalRisk < best.totalRisk) ||
        (cand.maxRisk === best.maxRisk && cand.totalRisk === best.totalRisk && cand.spread < best.spread) ||
        (cand.maxRisk === best.maxRisk &&
          cand.totalRisk === best.totalRisk &&
          cand.spread === best.spread &&
          lex(cand.assignment, best.assignment) < 0)
      ) {
        best = cand;
      }
      return;
    }
    if (fixed[u] !== -1) {
      assign[u] = fixed[u]!;
      enumerate(u + 1);
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

function makeRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

test('preassignments: solver matches fixed-aware oracle on random instances', () => {
  const rng = makeRng(20261004);
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
            ? threshold + Math.floor(rng() * 4)
            : 1 + Math.floor(rng() * (threshold - 1));
          riskPairs.push({ a: names[i]!, b: names[j]!, risk: r });
        }
      }
    }
    // 1..4 distinct, immovable placements.
    const pCount = 1 + Math.floor(rng() * 4);
    const order = names.map((_, i) => i).sort(() => rng() - 0.5);
    const preassignments = [];
    for (let x = 0; x < Math.min(pCount, n); x++) {
      preassignments.push({ amplicon: names[order[x]!]!, pool: 1 + Math.floor(rng() * k) });
    }
    const req: AllocateRequest = {
      amplicons: names.map((name, i) => ({ name, load: loads[i]!, isControl: isControl[i]! })),
      poolCount: k,
      loadRange: { min: minLoad, max: maxLoad },
      riskPairs,
      hardThreshold: threshold,
      preassignments,
    };
    const inst = buildInstance(req);
    const expected = fixedOracle(inst);
    const actual: SolverSolution | null = solve(inst);
    if (expected === null) {
      assert.equal(actual, null, `case ${t}: should be infeasible with fixed placements`);
    } else {
      feasibleCount++;
      assert.ok(actual, `case ${t}: should find a solution`);
      assert.deepEqual(
        [actual!.maxRisk, actual!.totalRisk, actual!.spread, actual!.assignment],
        [expected.maxRisk, expected.totalRisk, expected.spread, expected.assignment],
        `case ${t}: objective/assignment mismatch`,
      );
      for (const pa of preassignments) {
        const idx = names.indexOf(pa.amplicon);
        assert.equal(
          actual!.assignment[idx],
          pa.pool - 1,
          `case ${t}: preassigned ${pa.amplicon} must stay in pool ${pa.pool}`,
        );
      }
    }
  }
  assert.ok(feasibleCount > 30, `expected many feasible fixed cases, got ${feasibleCount}`);
});

/* ------------------------ a preplacement moves the optimum ------------------------ */

test('a preplacement changes the optimum but is respected end to end', () => {
  const req: AllocateRequest = {
    amplicons: Array.from({ length: 8 }, (_, i) => ({ name: `B${i}`, load: 10, isControl: true })),
    poolCount: 2,
    loadRange: { min: 30, max: 50 },
    riskPairs: [
      { a: 'B0', b: 'B2', risk: 4 },
      { a: 'B1', b: 'B3', risk: 4 },
    ],
    hardThreshold: 9,
  };

  const free = allocate(req);
  assert.equal(free.feasible, true);
  assert.equal(free.maxPoolRisk, 0, 'unconstrained optimum separates both soft pairs');
  assert.equal(free.totalRisk, 0);

  const fixed = allocate({
    ...req,
    preassignments: [
      { amplicon: 'B0', pool: 1 },
      { amplicon: 'B2', pool: 1 },
    ],
  });
  assert.equal(fixed.feasible, true);
  assert.equal(fixed.maxPoolRisk, 4, 'the forced co-location makes risk 4 unavoidable');
  assert.equal(fixed.totalRisk, 4);
  const where = new Map(fixed.assignment!.map((x) => [x.amplicon, x.pool]));
  assert.equal(where.get('B0'), 1);
  assert.equal(where.get('B2'), 1);
  // The pool detail mirrors the forced placement too.
  const pool1 = fixed.pools!.find((p) => p.pool === 1)!;
  for (const m of ['B0', 'B2']) assert.ok(pool1.members.includes(m), `pool 1 contains fixed ${m}`);
  assert.ok(pool1.riskPairs.some((rp) => rp.a === 'B0' && rp.b === 'B2' && rp.risk === 4));
  assert.equal(pool1.riskSum, 4);
  // All amplicons still allocated exactly once, every pool valid.
  assert.equal(where.size, 8);
  for (const p of fixed.pools!) {
    assert.ok(p.load >= 30 && p.load <= 50);
    assert.ok(p.controls.length >= 1);
  }
});

/* --------------------- preassignment-driven impossibility --------------------- */

test('infeasible: forbidden pair forced into one pool is summarized with members and pool', () => {
  const req: AllocateRequest = {
    amplicons: Array.from({ length: 8 }, (_, i) => ({ name: `A${i}`, load: 10, isControl: true })),
    poolCount: 2,
    loadRange: { min: 30, max: 50 },
    riskPairs: [{ a: 'A0', b: 'A1', risk: 9 }],
    hardThreshold: 9,
    preassignments: [
      { amplicon: 'A0', pool: 1 },
      { amplicon: 'A1', pool: 1 },
    ],
  };
  const res = allocate(req);
  assert.equal(res.feasible, false);
  const conflicts = res.conflictSummary!.preassignmentConflicts!;
  assert.equal(conflicts.length, 1);
  assert.deepEqual(new Set(conflicts[0]!.members), new Set(['A0', 'A1']));
  assert.equal(conflicts[0]!.pool, 1);
  assert.equal(conflicts[0]!.rule, 'forbiddenPair');
  assert.equal(conflicts[0]!.risk, 9);
});

test('infeasible: a pool preloaded past max is summarized as poolOverloaded', () => {
  // Three load-10 amplicons fixed into pool 1 already exceed max 25; total
  // load (50) still fits the combined capacity, so only the fixed overload
  // proves impossibility.
  const req: AllocateRequest = {
    amplicons: [
      { name: 'F0', load: 10, isControl: true },
      { name: 'F1', load: 10, isControl: true },
      { name: 'F2', load: 10, isControl: true },
      { name: 'x0', load: 4, isControl: true },
      { name: 'x1', load: 4, isControl: false },
      { name: 'x2', load: 4, isControl: false },
      { name: 'x3', load: 4, isControl: false },
      { name: 'x4', load: 4, isControl: false },
    ],
    poolCount: 2,
    loadRange: { min: 20, max: 25 },
    riskPairs: [],
    hardThreshold: 9,
    preassignments: [
      { amplicon: 'F0', pool: 1 },
      { amplicon: 'F1', pool: 1 },
      { amplicon: 'F2', pool: 1 },
    ],
  };
  const res = allocate(req);
  assert.equal(res.feasible, false);
  const conflicts = res.conflictSummary!.preassignmentConflicts!;
  assert.equal(conflicts.length, 1);
  assert.deepEqual(new Set(conflicts[0]!.members), new Set(['F0', 'F1', 'F2']));
  assert.equal(conflicts[0]!.pool, 1);
  assert.equal(conflicts[0]!.rule, 'poolOverloaded');
});

/* ----------------------------- backward compatibility ----------------------------- */

test('omitting preassignments keeps the ordinary optimum unchanged', () => {
  const req: AllocateRequest = {
    amplicons: Array.from({ length: 8 }, (_, i) => ({
      name: `S${i}`,
      load: 10,
      isControl: i % 2 === 0,
    })),
    poolCount: 2,
    loadRange: { min: 30, max: 50 },
    riskPairs: [],
    hardThreshold: 5,
  };
  const withoutField = allocate(req);
  const explicitlyEmpty: AllocateRequest = { ...req };
  assert.deepEqual(allocate(explicitlyEmpty), withoutField);
  assert.deepEqual(
    withoutField.assignment!.map((a) => a.pool),
    [1, 1, 1, 1, 2, 2, 2, 2],
  );
});
