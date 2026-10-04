/**
 * Exact pool-allocation solver.
 *
 * Every amplicon must be assigned to exactly one of k labelled pools.
 * Hard constraints: forbidden pairs (risk >= threshold) must be separated,
 * every pool load must lie in [minLoad, maxLoad], every pool must contain at
 * least one control.
 *
 * Objectives, minimised in strict lexicographic order:
 *   1. largest single-pool risk sum
 *   2. sum of all pool risk sums
 *   3. load spread (largest pool load - smallest pool load)
 *   4. the pool-number sequence flattened in amplicon recording order
 *
 * Two-phase branch-and-bound:
 *   - Phase 1 finds the optimum for objectives 1..3 with MRV variable order.
 *     Empty-pool symmetry breaking plus indistinguishable-pool elimination are
 *     safe there because permuting pool labels never changes a numeric
 *     objective.
 *   - Phase 2 fixes the numeric optimum and minimises objective 4 with
 *     variables taken in recording order (lexicographic prefix pruning). The
 *     lexicographically smallest solution is always canonically labelled
 *     (labels first appear 1,2,...), so empty-pool symmetry breaking remains
 *     complete in this ordered search.
 *
 * The search is exhaustive, so a negative answer proves that no feasible
 * allocation exists.
 */

export interface SolverInstance {
  n: number;
  k: number;
  names: string[];
  loads: number[];
  isControl: boolean[];
  /** Symmetric n*n risk matrix (unlisted pairs are 0). */
  risk: Int32Array;
  minLoad: number;
  maxLoad: number;
  /** Only *listed* pairs with risk >= threshold are hard-forbidden. */
  forbidden: Uint8Array;
}

export interface SolverSolution {
  assignment: number[];
  poolLoads: number[];
  poolRisk: number[];
  maxRisk: number;
  totalRisk: number;
  spread: number;
}

/** Safety valve: the configured problem size (n<=18, k<=4) stays far below it. */
const NODE_BUDGET = 50_000_000;

/** Find a maximum clique of the forbidden graph (Bron-Kerbosch with pivot). */
export function maxForbiddenClique(inst: SolverInstance): number[] {
  const { n, forbidden } = inst;
  const adj: number[] = [];
  for (let i = 0; i < n; i++) {
    let m = 0;
    for (let j = 0; j < n; j++) if (forbidden[i * n + j]) m |= 1 << j;
    adj.push(m);
  }
  let best: number[] = [];
  const pickVertex = (set: number): number => {
    const lsb = set & -set;
    return 31 - Math.clz32(lsb);
  };
  const bk = (r: number, p: number, x: number): void => {
    if (p === 0 && x === 0) {
      if (popcount(r) > best.length) best = maskToVertices(r);
      return;
    }
    const u = p | x;
    const uIdx = u === 0 ? -1 : pickVertex(u);
    let candidates = p & (uIdx === -1 ? 0 : ~adj[uIdx]!);
    if (candidates === 0) candidates = p;
    while (candidates) {
      const v = candidates & -candidates;
      const vi = 31 - Math.clz32(v);
      if (popcount(r) + popcount(p) <= best.length) return;
      bk(r | v, p & adj[vi]!, x & adj[vi]!);
      p &= ~v;
      x |= v;
      candidates &= ~v;
    }
  };
  bk(0, (1 << n) - 1, 0);
  return best;
}

function popcount(m: number): number {
  m = m - ((m >>> 1) & 0x55555555);
  m = (m & 0x33333333) + ((m >>> 2) & 0x33333333);
  return (((m + (m >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
}

function maskToVertices(mask: number): number[] {
  const out: number[] = [];
  let m = mask;
  while (m) {
    const v = m & -m;
    out.push(31 - Math.clz32(v));
    m &= m - 1;
  }
  return out;
}

/** Rigorous, cheap impossibility checks; null means "not proven here". */
export function obviousInfeasibility(
  inst: SolverInstance,
): { kind: 'controls' | 'load' | 'clique'; detail: string; clique?: number[] } | null {
  const { n, k, loads, isControl, minLoad, maxLoad } = inst;
  const controlCount = isControl.filter(Boolean).length;
  if (controlCount < k) {
    return {
      kind: 'controls',
      detail: `${controlCount} control amplicon(s) cannot cover ${k} pools (each pool needs at least one)`,
    };
  }
  for (let i = 0; i < n; i++) {
    if (loads[i]! > maxLoad) {
      return {
        kind: 'load',
        detail: `amplicon "${inst.names[i]}" has load ${loads[i]} which alone exceeds pool max ${maxLoad}`,
      };
    }
  }
  const total = loads.reduce((a, b) => a + b, 0);
  if (total < k * minLoad) {
    return {
      kind: 'load',
      detail: `total load ${total} cannot fill ${k} pools to the minimum ${minLoad} (need at least ${k * minLoad})`,
    };
  }
  if (total > k * maxLoad) {
    return {
      kind: 'load',
      detail: `total load ${total} exceeds the combined capacity of ${k} pools at max ${maxLoad} (${k * maxLoad})`,
    };
  }
  const clique = maxForbiddenClique(inst);
  if (clique.length > k) {
    return {
      kind: 'clique',
      detail: `forbidden clique of size ${clique.length} exceeds pool count ${k}`,
      clique,
    };
  }
  return null;
}

interface SearchState {
  poolLoad: Int32Array;
  poolRisk: Int32Array;
  poolControl: Int32Array;
  members: Int32Array;
  assignment: Int8Array;
  remMask: number;
  curMaxRisk: number;
  curTotalRisk: number;
}

export function solve(inst: SolverInstance): SolverSolution | null {
  if (obviousInfeasibility(inst)) return null;

  const { n, k, loads, isControl, risk, forbidden, minLoad, maxLoad } = inst;
  const totalLoad = loads.reduce((a, b) => a + b, 0);

  // Per-amplicon forbidden-neighbour bit masks.
  const forbidMask = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    let m = 0;
    for (let j = 0; j < n; j++) if (forbidden[i * n + j]) m |= 1 << j;
    forbidMask[i] = m;
  }

  const newState = (): SearchState => ({
    poolLoad: new Int32Array(k),
    poolRisk: new Int32Array(k),
    poolControl: new Int32Array(k),
    members: new Int32Array(k),
    assignment: new Int8Array(n),
    remMask: (1 << n) - 1,
    curMaxRisk: 0,
    curTotalRisk: 0,
  });

  let nodes = 0;
  const tick = (): void => {
    if (++nodes > NODE_BUDGET) {
      throw new Error(`solver node budget (${NODE_BUDGET}) exceeded`);
    }
  };

  /** Pools u could enter given capacity and forbidden neighbours. */
  const allowedMaskFor = (st: SearchState, u: number): number => {
    let mask = 0;
    const fm = forbidMask[u]!;
    for (let j = 0; j < k; j++) {
      if (st.poolLoad[j]! + loads[u]! <= maxLoad && (st.members[j]! & fm) === 0) {
        mask |= 1 << j;
      }
    }
    return mask;
  };

  const addedRisk = (st: SearchState, u: number, j: number): number => {
    let added = 0;
    let mm = st.members[j]!;
    while (mm) {
      const wv = mm & -mm;
      added += risk[u * n + (31 - Math.clz32(wv))]!;
      mm &= mm - 1;
    }
    return added;
  };

  /**
   * Prefix feasibility checks shared by both phases.
   * `spreadLimit` (when non-null) bounds the final load spread that must still
   * be achievable; pruning is substantially tighter than an aggregate bound.
   */
  const prefixFeasible = (st: SearchState, rem: number, spreadLimit: number | null): boolean => {
    // remaining load
    let remLoad = 0;
    let m = rem;
    while (m) {
      remLoad += loads[31 - Math.clz32(m & -m)]!;
      m &= m - 1;
    }

    let curMinLoad = Infinity;
    let curMaxLoad = -Infinity;
    for (let j = 0; j < k; j++) {
      if (st.poolLoad[j]! < curMinLoad) curMinLoad = st.poolLoad[j]!;
      if (st.poolLoad[j]! > curMaxLoad) curMaxLoad = st.poolLoad[j]!;
    }

    // subset-sum bitset of the remaining amplicons (capped to avoid huge ints)
    let ssBits: bigint | null = null;
    if (maxLoad <= 1_000_000) {
      const mask = (1n << BigInt(maxLoad + 1)) - 1n;
      ssBits = 1n;
      let sm = rem;
      while (sm) {
        const i = 31 - Math.clz32(sm & -sm);
        ssBits = (ssBits | (ssBits << BigInt(loads[i]!))) & mask;
        sm &= sm - 1;
      }
    }

    /* ---- load interval feasibility ---- */
    let needSum = 0;
    let capSum = 0;
    for (let j = 0; j < k; j++) {
      const deficit = Math.max(0, minLoad - st.poolLoad[j]!);
      const slack = maxLoad - st.poolLoad[j]!;
      needSum += deficit;
      capSum += slack;
      if (deficit > 0 && ssBits !== null) {
        // A subset of the remainder must bring THIS pool into [min,max].
        const window = (1n << BigInt(slack - deficit + 1)) - 1n;
        if (((ssBits >> BigInt(deficit)) & window) === 0n) return false;
      }
    }
    if (needSum > remLoad || capSum < remLoad) return false;

    /* ---- tight spread feasibility ---- */
    if (spreadLimit !== null && ssBits !== null) {
      // If the final spread is <= S, let m be the final minimum pool load:
      // every pool must end in [m, m+S]. The possible m range is narrow; for
      // some integer m in it, EACH pool must be reachable inside its per-pool
      // interval by some subset of the remaining items (a necessary, cheap
      // relaxation; subset disjointness is left to the search).
      const avgCeil = Math.ceil(totalLoad / k);
      const avgFloor = Math.floor(totalLoad / k);
      // Final minimum m must satisfy:
      //   m >= minLoad, m >= curMinLoad (loads only grow),
      //   m >= curMaxLoad - S and m >= ceil(total/k) - S (final max bound),
      //   m <= floor(total/k), m <= curMinLoad + remLoad.
      const mLo = Math.max(minLoad, curMinLoad, curMaxLoad - spreadLimit, avgCeil - spreadLimit);
      const mHi = Math.min(avgFloor, curMinLoad + remLoad);
      if (mLo > mHi) return false;
      // Bound the enumeration cost; a wide range means the bound is loose and
      // the aggregate relaxation below is used instead.
      if (mHi - mLo <= 64) {
        let anyM = false;
        for (let mm2 = mLo; mm2 <= mHi; mm2++) {
          let ok = true;
          let lowerSum = 0;
          let upperSum = 0;
          for (let j = 0; j < k; j++) {
            const lo = Math.max(0, mm2 - st.poolLoad[j]!, minLoad - st.poolLoad[j]!);
            const hi = Math.min(maxLoad, mm2 + spreadLimit) - st.poolLoad[j]!;
            lowerSum += lo;
            upperSum += hi;
            if (hi < 0) {
              ok = false;
              break;
            }
            if (ssBits !== null && lo > 0) {
              const window = (1n << BigInt(hi - lo + 1)) - 1n;
              if (((ssBits >> BigInt(lo)) & window) === 0n) {
                ok = false;
                break;
              }
            }
          }
          if (ok && lowerSum <= remLoad && upperSum >= remLoad) {
            anyM = true;
            break;
          }
        }
        if (!anyM) return false;
      } else {
        const lbFinalMax = Math.max(curMaxLoad, avgCeil);
        const ubFinalMin = Math.min(curMinLoad + remLoad, avgFloor);
        if (Math.max(0, lbFinalMax - ubFinalMin) > spreadLimit) return false;
      }
    }

    /* ---- forward checking over the true domains (MRV-equivalent pruning) ---- */
    const domains = new Int32Array(n);
    let vm = rem;
    while (vm) {
      const u = 31 - Math.clz32(vm & -vm);
      const allowed = allowedMaskFor(st, u);
      domains[u] = allowed;
      if (allowed === 0) return false;
      vm &= vm - 1;
    }

    // Pools still needing a control must be matchable to distinct remaining
    // controls allowed into them (Hall, k<=4 -> enumerate subsets).
    let needyPools = 0;
    for (let j = 0; j < k; j++) if (st.poolControl[j] === 0) needyPools |= 1 << j;
    if (needyPools !== 0) {
      const controlDomains: number[] = [];
      let cm = rem;
      while (cm) {
        const u = 31 - Math.clz32(cm & -cm);
        if (isControl[u]) controlDomains.push(domains[u]!);
        cm &= cm - 1;
      }
      let q = needyPools;
      while (q) {
        const sub = q;
        let adjacent = 0;
        for (const d of controlDomains) if (d & sub) adjacent++;
        if (adjacent < popcount(sub)) return false;
        q = (q - 1) & needyPools;
      }
    }

    return true;
  };

  const place = (st: SearchState, u: number, j: number): { added: number; prevMax: number } => {
    const added = addedRisk(st, u, j);
    st.poolLoad[j]! += loads[u]!;
    st.poolRisk[j]! += added;
    st.poolControl[j]! += isControl[u] ? 1 : 0;
    st.members[j]! |= 1 << u;
    st.assignment[u]! = j;
    st.remMask &= ~(1 << u);
    st.curTotalRisk += added;
    const prevMax = st.curMaxRisk;
    if (st.poolRisk[j]! > st.curMaxRisk) st.curMaxRisk = st.poolRisk[j]!;
    return { added, prevMax };
  };

  const unplace = (st: SearchState, u: number, j: number, added: number, prevMax: number): void => {
    st.curMaxRisk = prevMax;
    st.curTotalRisk -= added;
    st.remMask |= 1 << u;
    st.members[j]! &= ~(1 << u);
    st.poolControl[j]! -= isControl[u] ? 1 : 0;
    st.poolRisk[j]! -= added;
    st.poolLoad[j]! -= loads[u]!;
  };

  /* ============================ Phase 1: numeric optimum ============================ */

  const st = newState();
  let bestAssignment: Int8Array | null = null;
  let bestMax = Infinity;
  let bestTotal = Infinity;
  let bestSpread = Infinity;

  const firstEmptyPool = (): number => {
    for (let j = 0; j < k; j++) if (st.members[j] === 0) return j;
    return k;
  };

  const phase1 = (): void => {
    tick();
    const rem = st.remMask;
    if (rem === 0) {
      for (let j = 0; j < k; j++) {
        const l = st.poolLoad[j]!;
        if (l < minLoad || l > maxLoad || st.poolControl[j] === 0) return;
      }
      let mn = Infinity;
      let mx = -Infinity;
      for (let j = 0; j < k; j++) {
        if (st.poolLoad[j]! < mn) mn = st.poolLoad[j]!;
        if (st.poolLoad[j]! > mx) mx = st.poolLoad[j]!;
      }
      const spread = mx - mn;
      if (
        bestAssignment === null ||
        st.curMaxRisk < bestMax ||
        (st.curMaxRisk === bestMax && st.curTotalRisk < bestTotal) ||
        (st.curMaxRisk === bestMax &&
          st.curTotalRisk === bestTotal &&
          spread < bestSpread)
      ) {
        bestAssignment = Int8Array.from(st.assignment);
        bestMax = st.curMaxRisk;
        bestTotal = st.curTotalRisk;
        bestSpread = spread;
      }
      return;
    }

    if (st.curMaxRisk > bestMax) return;
    if (st.curMaxRisk === bestMax && st.curTotalRisk > bestTotal) return;
    // We only need a STRICTLY better spread to replace the incumbent, so a
    // completion whose spread cannot beat bestSpread-1 is irrelevant.
    const spreadTarget =
      st.curMaxRisk === bestMax && st.curTotalRisk === bestTotal && Number.isFinite(bestSpread)
        ? bestSpread - 1
        : null;
    if (!prefixFeasible(st, rem, spreadTarget)) {
      return;
    }

    const firstEmpty = firstEmptyPool();
    const legalMask = (1 << (firstEmpty + 1)) - 1;

    // MRV variable selection over symmetry-legal pools
    let bestU = -1;
    let bestCount = k + 1;
    let vm = rem;
    while (vm) {
      const u = 31 - Math.clz32(vm & -vm);
      const count = popcount(allowedMaskFor(st, u) & legalMask);
      // An empty pool accepts every amplicon, so a symmetry-legal domain of 0
      // implies the true domain is 0 as well.
      if (count === 0) return;
      if (count < bestCount) {
        bestCount = count;
        bestU = u;
      }
      vm &= vm - 1;
    }

    const u = bestU;
    const branches: { j: number; added: number }[] = [];
    let cb = allowedMaskFor(st, u) & legalMask;
    while (cb) {
      const j = 31 - Math.clz32(cb & -cb);
      branches.push({ j, added: addedRisk(st, u, j) });
      cb &= cb - 1;
    }
    // Sibling symmetry elimination: pools that are indistinguishable for every
    // remaining decision (same load, control count, accumulated risk, and the
    // same risk/forbidden profile against each remaining amplicon) lead to
    // equivalent continuations. Keep one representative per signature.
    const seenSigs = new Set<string>();
    const distinct: typeof branches = [];
    for (const b of branches) {
      const j = b.j;
      let sig = `${st.poolLoad[j]}.${st.poolControl[j]}.${st.poolRisk[j]}|`;
      let vm2 = rem;
      while (vm2) {
        const v = 31 - Math.clz32(vm2 & -vm2);
        sig += `${addedRisk(st, v, j)},${(st.members[j]! & forbidMask[v]!) !== 0 ? 1 : 0};`;
        vm2 &= vm2 - 1;
      }
      if (!seenSigs.has(sig)) {
        seenSigs.add(sig);
        distinct.push(b);
      }
    }
    branches.length = 0;
    branches.push(...distinct);
    // Least added risk first, then lightest pool: strong early incumbent.
    branches.sort(
      (p, q) => p.added - q.added || st.poolLoad[p.j]! - st.poolLoad[q.j]! || p.j - q.j,
    );

    for (const { j } of branches) {
      const { added, prevMax } = place(st, u, j);
      phase1();
      unplace(st, u, j, added, prevMax);
    }
  };

  /* ====================== Phase 2: lexicographic optimum at fixed numerics ====================== */

  let lexBest: Int8Array | null = bestAssignment === null ? null : Int8Array.from(bestAssignment);

  const phase2 = (u: number): void => {
    tick();
    if (u === n) {
      for (let j = 0; j < k; j++) {
        const l = st.poolLoad[j]!;
        if (l < minLoad || l > maxLoad || st.poolControl[j] === 0) return;
      }
      let mn = Infinity;
      let mx = -Infinity;
      for (let j = 0; j < k; j++) {
        if (st.poolLoad[j]! < mn) mn = st.poolLoad[j]!;
        if (st.poolLoad[j]! > mx) mx = st.poolLoad[j]!;
      }
      if (mx - mn !== bestSpread || st.curMaxRisk !== bestMax || st.curTotalRisk !== bestTotal) {
        return;
      }
      if (lexBest === null || lexSmaller(st.assignment, lexBest)) {
        lexBest = Int8Array.from(st.assignment);
      }
      return;
    }

    if (st.curMaxRisk > bestMax || st.curTotalRisk > bestTotal) return;
    const rem = ((1 << n) - 1) ^ ((1 << u) - 1);
    if (!prefixFeasible(st, rem, bestSpread)) return;

    // Lexicographic pruning against the incumbent: the assigned prefix is
    // compared with the best sequence. Because variables run in recording
    // order, a prefix already greater than the incumbent can never recover.
    let prefixCmp = 0; // -1: smaller, 0: equal, 1: greater
    if (lexBest !== null) {
      for (let i = 0; i < u; i++) {
        if (st.assignment[i]! < lexBest[i]!) {
          prefixCmp = -1;
          break;
        }
        if (st.assignment[i]! > lexBest[i]!) {
          prefixCmp = 1;
          break;
        }
      }
    }
    if (prefixCmp === 1) return;

    // Empty-pool symmetry breaking: with variables fixed in recording order,
    // the lexicographically smallest solution is always canonically labelled
    // (pool labels appear in order of first use), so this restriction never
    // hides the optimum.
    let firstEmpty = k;
    for (let j = 0; j < k; j++) if (st.members[j] === 0) {
      firstEmpty = j;
      break;
    }

    const allowed = allowedMaskFor(st, u) & ((1 << (firstEmpty + 1)) - 1);
    for (let j = 0; j < k; j++) {
      if ((allowed & (1 << j)) === 0) continue;
      if (prefixCmp === 0 && lexBest !== null && j > lexBest[u]!) continue;
      const { added, prevMax } = place(st, u, j);
      phase2(u + 1);
      unplace(st, u, j, added, prevMax);
    }
  };

  try {
    phase1();
    if (bestAssignment !== null) {
      // Phase 2 restarts from an empty state: numeric objectives are fixed and
      // it searches for the lexicographically smallest full labelling.
      st.poolLoad.fill(0);
      st.poolRisk.fill(0);
      st.poolControl.fill(0);
      st.members.fill(0);
      st.assignment.fill(-1);
      st.remMask = (1 << n) - 1;
      st.curMaxRisk = 0;
      st.curTotalRisk = 0;
      phase2(0);
    }
  } catch (e) {
    if (e instanceof Error && e.message.startsWith('solver node budget')) {
      throw new Error('allocation search exceeded its node budget; refusing a non-verified answer');
    }
    throw e;
  }

  if (lexBest === null) return null;
  const poolLoads: number[] = [];
  const poolRisks: number[] = [];
  for (let j = 0; j < k; j++) {
    let load = 0;
    let rsum = 0;
    for (let i = 0; i < n; i++) {
      if (lexBest[i] === j) {
        load += loads[i]!;
        for (let w = i + 1; w < n; w++) if (lexBest[w] === j) rsum += risk[i * n + w]!;
      }
    }
    poolLoads.push(load);
    poolRisks.push(rsum);
  }
  return {
    assignment: Array.from(lexBest),
    poolLoads,
    poolRisk: poolRisks,
    maxRisk: Number(bestMax),
    totalRisk: Number(bestTotal),
    spread: Number(bestSpread),
  };
}

function lexSmaller(a: Int8Array, b: Int8Array): boolean {
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return a[i]! < b[i]!;
  }
  return false;
}
