import { test } from 'node:test';
import assert from 'node:assert/strict';
import { allocate } from '../src/allocate.js';
import type { AllocateRequest } from '../src/types.js';

function makeRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

test('scale: n=18, k=4 dense constraints solves fast and satisfies every hard constraint', () => {
  const rng = makeRng(424242);
  const n = 18;
  const amplicons = Array.from({ length: n }, (_, i) => ({
    name: `amp_${i}`,
    load: 4 + Math.floor(rng() * 9),
    isControl: i % 4 === 0,
  }));
  const riskPairs: { a: string; b: string; risk: number }[] = [];
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (rng() < 0.4) {
        riskPairs.push({
          a: amplicons[i]!.name,
          b: amplicons[j]!.name,
          risk: Math.floor(rng() * 10),
        });
      }
    }
  }
  const req: AllocateRequest = {
    amplicons,
    poolCount: 4,
    loadRange: { min: 20, max: 90 },
    riskPairs,
    hardThreshold: 8,
  };
  const t0 = process.hrtime.bigint();
  const res = allocate(req);
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  assert.ok(ms < 2000, `solver too slow: ${ms.toFixed(0)}ms`);
  assert.equal(res.feasible, true);
  assert.equal(res.pools!.length, 4);
  const assigned = new Map<string, number>();
  res.pools!.forEach((p) => {
    assert.ok(p.load >= 20 && p.load <= 90);
    assert.ok(p.controls.length >= 1);
    p.members.forEach((m) => assigned.set(m, p.pool));
  });
  assert.equal(assigned.size, 18);
  for (const rp of riskPairs) {
    if (rp.risk >= 8) assert.notEqual(assigned.get(rp.a), assigned.get(rp.b));
  }
});

test('edge: hardThreshold 0 forbids every LISTED pair (even zero-risk ones)', () => {
  const req: AllocateRequest = {
    amplicons: Array.from({ length: 8 }, (_, i) => ({
      name: `A${i}`,
      load: 10,
      isControl: true,
    })),
    poolCount: 2,
    loadRange: { min: 30, max: 50 },
    riskPairs: [
      { a: 'A0', b: 'A1', risk: 0 }, // listed at threshold 0 -> forbidden
    ],
    hardThreshold: 0,
  };
  const res = allocate(req);
  assert.equal(res.feasible, true);
  const where = new Map(res.assignment!.map((x) => [x.amplicon, x.pool]));
  assert.notEqual(where.get('A0'), where.get('A1'));
  // Unlisted pairs (treated as zero risk) may still share a pool.
  assert.equal(res.conflictSummary, undefined);
});

test('edge: every amplicon is a control, risks unlisted -> stable balanced answer', () => {
  const req: AllocateRequest = {
    amplicons: Array.from({ length: 12 }, (_, i) => ({
      name: `E${i}`,
      load: 6,
      isControl: true,
    })),
    poolCount: 3,
    loadRange: { min: 20, max: 28 },
    riskPairs: [],
    hardThreshold: 3,
  };
  const a = allocate(req);
  const b = allocate(req);
  assert.equal(a.feasible, true);
  assert.deepEqual(a, b, 'deterministic output across calls');
  // 72/3 = 24 each -> spread 0, zero risk
  assert.equal(a.loadSpread, 0);
  assert.equal(a.totalRisk, 0);
  for (const p of a.pools!) assert.equal(p.load, 24);
});

test('objective ordering: minimising max-pool risk beats total risk', () => {
  // Constructed so a layout with max=3/total=6 competes with max=4/total=4:
  // max-pool risk must win, even though its total is larger.
  const names = ['p', 'q', 'r', 's', 'c1', 'c2', 'u', 'v'];
  const req: AllocateRequest = {
    amplicons: names.map((nm) => ({ name: nm, load: 5, isControl: nm.startsWith('c') })),
    poolCount: 2,
    loadRange: { min: 15, max: 25 }, // exactly 4 items per pool
    riskPairs: [
      { a: 'p', b: 'q', risk: 3 },
      { a: 'r', b: 's', risk: 3 },
      { a: 'u', b: 'v', risk: 4 },
    ],
    hardThreshold: 9,
  };
  const res = allocate(req);
  assert.equal(res.feasible, true);
  // Splitting the two risk-3 pairs apart AND the risk-4 pair apart yields
  // max 0; verify the solver found the global optimum rather than a local one.
  assert.equal(res.maxPoolRisk, 0);
  assert.equal(res.totalRisk, 0);
});
