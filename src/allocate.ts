import {
  obviousInfeasibility,
  preassignmentViolations,
  solve,
  type SolverInstance,
} from './solver.js';
import type { AllocateRequest, AllocateResponse, PoolResult } from './types.js';

export function buildInstance(req: AllocateRequest): SolverInstance {
  const n = req.amplicons.length;
  const k = req.poolCount;
  const names = req.amplicons.map((a) => a.name);
  const loads = req.amplicons.map((a) => a.load);
  const isControl = req.amplicons.map((a) => a.isControl);

  const risk = new Int32Array(n * n);
  const forbidden = new Uint8Array(n * n);
  const index = new Map<string, number>(names.map((name, i) => [name, i]));

  for (const p of req.riskPairs) {
    const i = index.get(p.a)!;
    const j = index.get(p.b)!;
    risk[i * n + j] = p.risk;
    risk[j * n + i] = p.risk;
    if (p.risk >= req.hardThreshold) {
      forbidden[i * n + j] = 1;
      forbidden[j * n + i] = 1;
    }
  }

  // Immovable lab placements; -1 means the amplicon is still to be allocated.
  const fixed = new Int8Array(n).fill(-1);
  for (const pa of req.preassignments ?? []) {
    fixed[index.get(pa.amplicon)!]! = pa.pool - 1;
  }

  return {
    n,
    k,
    names,
    loads,
    isControl,
    risk,
    minLoad: req.loadRange.min,
    maxLoad: req.loadRange.max,
    forbidden,
    fixed,
  };
}

export function allocate(req: AllocateRequest): AllocateResponse {
  const inst = buildInstance(req);
  const sol = solve(inst);

  if (!sol) {
    return { feasible: false, conflictSummary: buildConflictSummary(inst) };
  }

  const pools: PoolResult[] = [];
  for (let j = 0; j < inst.k; j++) {
    const memberIdx: number[] = [];
    for (let i = 0; i < inst.n; i++) {
      if (sol.assignment[i] === j) memberIdx.push(i);
    }
    // Recording order for stable, deterministic output.
    memberIdx.sort((a, b) => a - b);
    const members = memberIdx.map((i) => inst.names[i]!);
    const controls = memberIdx.filter((i) => inst.isControl[i]).map((i) => inst.names[i]!);
    const riskPairs = [];
    for (let x = 0; x < memberIdx.length; x++) {
      for (let y = x + 1; y < memberIdx.length; y++) {
        const i = memberIdx[x]!;
        const w = memberIdx[y]!;
        const r = inst.risk[i * inst.n + w]!;
        if (r > 0) riskPairs.push({ a: inst.names[i]!, b: inst.names[w]!, risk: r });
      }
    }
    pools.push({
      pool: j + 1,
      members,
      load: sol.poolLoads[j]!,
      controls,
      riskPairs,
      riskSum: sol.poolRisk[j]!,
    });
  }

  return {
    feasible: true,
    poolCount: inst.k,
    pools,
    maxPoolRisk: sol.maxRisk,
    totalRisk: sol.totalRisk,
    loadSpread: sol.spread,
    assignment: sol.assignment.map((p, i) => ({ amplicon: inst.names[i]!, pool: p + 1 })),
  };
}

function buildConflictSummary(inst: SolverInstance) {
  const forbiddenPairs: { a: string; b: string; risk: number }[] = [];
  for (let i = 0; i < inst.n; i++) {
    for (let j = i + 1; j < inst.n; j++) {
      if (inst.forbidden[i * inst.n + j]) {
        forbiddenPairs.push({
          a: inst.names[i]!,
          b: inst.names[j]!,
          risk: inst.risk[i * inst.n + j]!,
        });
      }
    }
  }

  const reason = obviousInfeasibility(inst);
  const out: NonNullable<AllocateResponse['conflictSummary']> = {
    forbiddenPairs,
    overCapacityClique: [],
  };

  const controlCount = inst.isControl.filter(Boolean).length;
  if (controlCount < inst.k) out.poolsWithoutControl = inst.k - controlCount;
  if (reason?.kind === 'load') out.loadIssue = reason.detail;
  if (reason?.kind === 'clique' && reason.clique) {
    out.overCapacityClique = reason.clique.map((i) => inst.names[i]!);
  }

  const preConflicts = preassignmentViolations(inst);
  if (preConflicts.length > 0) {
    out.preassignmentConflicts = preConflicts.map((v) => ({
      members: v.members.map((i) => inst.names[i]!),
      pool: v.pool + 1,
      rule: v.kind === 'forbiddenPair' ? 'forbiddenPair' : 'poolOverloaded',
      ...(v.risk !== undefined ? { risk: v.risk } : {}),
    }));
  }
  return out;
}
