#!/usr/bin/env node
/**
 * One-shot verification entry point (service "verify" in docker-compose).
 *
 * Stages:
 *   1. TypeScript build
 *   2. node:test suite
 *   3. wait for the application /health endpoint
 *   4. exercise POST /api/pools/allocate:
 *        - a non-greedy trap request (greedy placement is suboptimal; the
 *          exact answer must be returned and re-checked client-side)
 *        - a preassignment request where one immovable placement changes the
 *          optimal allocation (the unconstrained optimum is forbidden by the
 *          fixed pool)
 *        - preassignment-driven impossibility (fixed forbidden pair and an
 *          overloaded preloaded pool), with located conflict summaries
 *        - an invalid request (field-located errors)
 *        - a legal-but-infeasible request (conflict summary)
 *        - determinism: the same feasible request twice yields the same body
 *
 * Exit code is a bit mask (0 = everything passed):
 *   1  build failure
 *   2  test failure
 *   4  application never became healthy
 *   8  API verification failure
 *
 * The process exits by itself; compose runs it with restart: "no".
 */
import { spawnSync } from 'node:child_process';

const APP_URL = process.env.APP_URL ?? 'http://app:3000';
const HEALTH_TIMEOUT_MS = Number.parseInt(process.env.HEALTH_TIMEOUT_MS ?? '60000', 10);
let failures = 0;

const log = (stage, msg) => console.log(`[verify:${stage}] ${msg}`);
const fail = (stage, msg) => {
  console.error(`[verify:${stage}] FAIL ${msg}`);
};

const run = (cmd, args) => {
  const r = spawnSync(cmd, args, { stdio: 'inherit', cwd: process.env.VERIFY_CWD ?? '/app' });
  if (r.error) throw r.error;
  return r.status ?? 1;
};

/* ------------------------------- stage 1: build ------------------------------- */
log('build', 'running TypeScript build...');
if (run('npx', ['tsc', '-p', 'tsconfig.json']) !== 0) {
  fail('build', 'TypeScript build failed');
  failures |= 1;
}

/* -------------------------------- stage 2: tests ------------------------------- */
if ((failures & 1) === 0) {
  log('test', 'running node:test suite...');
  if (run('node', ['--test', 'dist/test/solver.test.js', 'dist/test/api.test.js', 'dist/test/preassign.test.js', 'dist/test/scale.test.js']) !== 0) {
    fail('test', 'test suite failed');
    failures |= 2;
  }
} else {
  fail('test', 'skipped because the build failed');
  failures |= 2;
}

/* ------------------------------ stage 3: health wait --------------------------- */
async function waitForHealth() {
  const deadline = Date.now() + HEALTH_TIMEOUT_MS;
  let lastErr = '';
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${APP_URL}/health`);
      if (res.ok) {
        const body = await res.json();
        if (body && body.status === 'ok') return true;
      }
      lastErr = `status ${res.status}`;
    } catch (err) {
      lastErr = err instanceof Error ? err.message : String(err);
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  fail('health', `application not healthy after ${HEALTH_TIMEOUT_MS}ms (${lastErr})`);
  return false;
}

const healthy = await waitForHealth();
if (!healthy) failures |= 4;

/* ------------------------------ stage 4: API checks ---------------------------- */
if (healthy) {
  log('api', `verifying allocation API at ${APP_URL}`);

  // Non-greedy trap. A naive "emptiest pool" strategy places a with X, b with
  // Y and d with Z, realising risk 7 per pool. The exact optimum deranges the
  // heavy items and reaches zero listed risk with perfectly balanced loads.
  const trap = {
    amplicons: [
      { name: 'X', load: 30, isControl: false },
      { name: 'Y', load: 30, isControl: false },
      { name: 'Z', load: 30, isControl: false },
      { name: 'c1', load: 10, isControl: true },
      { name: 'c2', load: 10, isControl: true },
      { name: 'c3', load: 10, isControl: true },
      { name: 'a', load: 30, isControl: false },
      { name: 'b', load: 30, isControl: false },
      { name: 'd', load: 30, isControl: false },
    ],
    poolCount: 3,
    loadRange: { min: 60, max: 80 },
    riskPairs: [
      { a: 'X', b: 'Y', risk: 9 },
      { a: 'X', b: 'Z', risk: 9 },
      { a: 'Y', b: 'Z', risk: 9 },
      { a: 'a', b: 'X', risk: 7 },
      { a: 'b', b: 'Y', risk: 7 },
      { a: 'd', b: 'Z', risk: 7 },
    ],
    hardThreshold: 9,
  };

  const post = async (body) => {
    const res = await fetch(`${APP_URL}/api/pools/allocate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: res.status, json: await res.json() };
  };

  const apiChecks = [];
  const expect = (cond, msg) => apiChecks.push({ ok: Boolean(cond), msg });

  try {
    const r1 = await post(trap);
    expect(r1.status === 200, `trap HTTP status 200 (got ${r1.status})`);
    const j = r1.json;
    expect(j.feasible === true, 'trap is feasible');
    if (j.feasible) {
      expect(j.poolCount === 3, 'three pools returned');
      expect(Array.isArray(j.pools) && j.pools.length === 3, 'three pool objects');

      // Re-verify every hard constraint and reported number client-side.
      const where = new Map();
      let loads = [0, 0, 0];
      let controls = [0, 0, 0];
      for (const p of j.pools) {
        expect(typeof p.pool === 'number' && p.pool >= 1 && p.pool <= 3, `pool id valid (${p.pool})`);
        for (const m of p.members) {
          expect(!where.has(m), `amplicon ${m} assigned exactly once`);
          where.set(m, p.pool);
        }
        const wantLoad = p.members
          .map((m) => trap.amplicons.find((a) => a.name === m).load)
          .reduce((x, y) => x + y, 0);
        expect(p.load === wantLoad, `pool ${p.pool} reported load ${p.load} equals recomputed ${wantLoad}`);
        loads[p.pool - 1] = p.load;
        expect(p.load >= 60 && p.load <= 80, `pool ${p.pool} load ${p.load} inside [60,80]`);
        expect(p.controls.length >= 1, `pool ${p.pool} has a positive control`);
        controls[p.pool - 1] = p.controls.length;
        for (const c of p.controls) {
          const amp = trap.amplicons.find((a) => a.name === c);
          expect(amp && amp.isControl, `pool ${p.pool} control ${c} really is a control`);
        }
        let riskSum = 0;
        for (const rp of p.riskPairs) {
          expect(rp.risk < trap.hardThreshold, `pool ${p.pool} pair (${rp.a},${rp.b}) below hard threshold`);
          riskSum += rp.risk;
        }
        expect(p.riskSum === riskSum, `pool ${p.pool} riskSum ${p.riskSum} equals recomputed ${riskSum}`);
      }
      expect(where.size === 9, `all 9 amplicons assigned (got ${where.size})`);
      for (const rp of trap.riskPairs) {
        if (rp.risk >= trap.hardThreshold) {
          expect(where.get(rp.a) !== where.get(rp.b), `forbidden pair ${rp.a}/${rp.b} separated`);
        }
      }
      // Exact-optimum assertions that defeat the greedy layout.
      expect(j.maxPoolRisk === 0, `maximum pool risk is 0 (got ${j.maxPoolRisk}; greedy yields 7)`);
      expect(j.totalRisk === 0, `total risk is 0 (got ${j.totalRisk})`);
      expect(j.loadSpread === 0, `load spread is 0 (got ${j.loadSpread})`);
      expect(Math.max(...loads) - Math.min(...loads) === 0, 'reported spread matches pool loads');

      // Determinism: repeat the request and compare bodies.
      const r1b = await post(trap);
      expect(JSON.stringify(r1b.json) === JSON.stringify(j), 'repeated request gives byte-identical allocation');

      // assignment list respects recording order
      expect(
        Array.isArray(j.assignment) &&
          j.assignment.every((x, i) => x.amplicon === trap.amplicons[i].name),
        'assignment follows amplicon recording order',
      );
    }

    // Invalid input must be rejected with field-located issues.
    const bad = await post({
      amplicons: [{ name: 'only', load: -1, isControl: true }],
      poolCount: 9,
      loadRange: { min: 50, max: 10 },
      riskPairs: [{ a: 'only', b: 'ghost', risk: -2 }],
      hardThreshold: -3,
    });
    expect(bad.status === 400, `invalid request HTTP 400 (got ${bad.status})`);
    const badFields = new Set((bad.json.issues ?? []).map((i) => i.field));
    for (const f of ['amplicons', 'amplicons[0].load', 'poolCount', 'loadRange', 'riskPairs[0].b', 'riskPairs[0].risk', 'hardThreshold']) {
      expect(badFields.has(f), `validation issue located at ${f}`);
    }

    // Legal but impossible: one control for three pools.
    const infeasible = await post({
      amplicons: Array.from({ length: 9 }, (_, i) => ({
        name: `A${i}`,
        load: 10,
        isControl: i === 0,
      })),
      poolCount: 3,
      loadRange: { min: 10, max: 200 },
      riskPairs: [],
      hardThreshold: 5,
    });
    expect(infeasible.status === 200, `infeasible request HTTP 200 (got ${infeasible.status})`);
    expect(infeasible.json.feasible === false, 'feasible=false reported');
    expect(
      infeasible.json.conflictSummary && infeasible.json.conflictSummary.poolsWithoutControl === 2,
      'conflict summary explains 2 pools without a possible control',
    );

    // Forbidden clique larger than the pool count.
    const clique = await post({
      amplicons: Array.from({ length: 8 }, (_, i) => ({ name: `A${i}`, load: 10, isControl: true })),
      poolCount: 2,
      loadRange: { min: 10, max: 400 },
      riskPairs: [
        { a: 'A0', b: 'A1', risk: 9 },
        { a: 'A0', b: 'A2', risk: 9 },
        { a: 'A1', b: 'A2', risk: 9 },
      ],
      hardThreshold: 9,
    });
    expect(clique.json.feasible === false, 'K3-into-2-pools reported infeasible');
    const cq = new Set(clique.json.conflictSummary?.overCapacityClique ?? []);
    expect(cq.size === 3 && ['A0', 'A1', 'A2'].every((x) => cq.has(x)), 'conflict summary lists the K3 clique');

    /* --------------------- preassignments --------------------- */

    // A soft pair (risk 4) that the unconstrained optimum separates. Fixing
    // both ends into pool 1 must move the optimum from risk 0 to risk 4 while
    // keeping every hard constraint; the immovable positions are honoured and
    // reflected in members/assignment/load/risk detail.
    const preBase = {
      amplicons: Array.from({ length: 8 }, (_, i) => ({ name: `B${i}`, load: 10, isControl: true })),
      poolCount: 2,
      loadRange: { min: 30, max: 50 },
      riskPairs: [
        { a: 'B0', b: 'B2', risk: 4 },
        { a: 'B1', b: 'B3', risk: 4 },
      ],
      hardThreshold: 9,
    };
    const preFree = await post(preBase);
    expect(preFree.json.feasible === true, 'preassignment baseline feasible');
    expect(preFree.json.maxPoolRisk === 0, `baseline optimum risk 0 (got ${preFree.json.maxPoolRisk})`);

    const preOne = await post({ ...preBase, preassignments: [{ amplicon: 'B0', pool: 2 }] });
    expect(preOne.json.feasible === true, 'single preassignment feasible');
    expect(preOne.json.maxPoolRisk === 0, 'single preassignment keeps the numeric optimum');
    expect(
      preOne.json.assignment.find((x) => x.amplicon === 'B0').pool === 2,
      'single preassignment pins B0 to pool 2 and re-labels the canonical allocation',
    );
    expect(
      JSON.stringify(preOne.json.assignment.map((x) => x.pool)) !==
        JSON.stringify(preFree.json.assignment.map((x) => x.pool)),
      'one fixed placement changes the optimal allocation vs the unconstrained one',
    );

    const preBoth = await post({
      ...preBase,
      preassignments: [
        { amplicon: 'B0', pool: 1 },
        { amplicon: 'B2', pool: 1 },
      ],
    });
    const pb = preBoth.json;
    expect(preBoth.status === 200, `forced-pair HTTP 200 (got ${preBoth.status})`);
    expect(pb.feasible === true, 'forced soft pair still yields a feasible allocation');
    expect(pb.maxPoolRisk === 4, `immovable co-location raises optimum max risk to 4 (got ${pb.maxPoolRisk})`);
    expect(pb.totalRisk === 4, `total risk is 4 (got ${pb.totalRisk})`);
    const preWhere = new Map(pb.assignment.map((x) => [x.amplicon, x.pool]));
    expect(preWhere.get('B0') === 1 && preWhere.get('B2') === 1, 'both fixed amplicons stay in pool 1');
    expect(preWhere.size === 8, 'preassignment response still assigns every amplicon once');
    const prePool1 = pb.pools.find((p) => p.pool === 1);
    expect(
      prePool1.members.includes('B0') && prePool1.members.includes('B2'),
      'pool 1 members list reflects the fixed pair',
    );
    expect(
      prePool1.riskPairs.some((rp) => rp.a === 'B0' && rp.b === 'B2' && rp.risk === 4),
      'pool 1 risk detail reports the forced risk-4 pair',
    );
    expect(prePool1.riskSum === 4, 'pool 1 riskSum reflects the fixed pair');
    expect(prePool1.load === prePool1.members.length * 10, 'pool 1 load reflects fixed + allocated members');
    for (const p of pb.pools) {
      expect(p.load >= 30 && p.load <= 50, `preassigned pool ${p.pool} load in range`);
      expect(p.controls.length >= 1, `preassigned pool ${p.pool} has a control`);
    }

    // Determinism with preassignments.
    const preBoth2 = await post({
      ...preBase,
      preassignments: [
        { amplicon: 'B0', pool: 1 },
        { amplicon: 'B2', pool: 1 },
      ],
    });
    expect(JSON.stringify(preBoth2.json) === JSON.stringify(pb), 'preassigned allocation is deterministic');

    // Invalid preassignments are rejected with field-located issues.
    const preBad = await post({
      ...preBase,
      preassignments: [
        { amplicon: 'GHOST', pool: 1 },
        { amplicon: 'B0', pool: 3 },
        { amplicon: 'B1', pool: 1 },
        { amplicon: 'B1', pool: 2 },
      ],
    });
    expect(preBad.status === 400, `invalid preassignments HTTP 400 (got ${preBad.status})`);
    const preBadFields = new Set((preBad.json.issues ?? []).map((i) => i.field));
    for (const f of ['preassignments[0].amplicon', 'preassignments[1].pool', 'preassignments[3].amplicon']) {
      expect(preBadFields.has(f), `validation issue located at ${f}`);
    }

    // Fixed forbidden pair: impossible, with members/pool/rule in the summary.
    const preForbidden = await post({
      ...preBase,
      riskPairs: [{ a: 'B0', b: 'B1', risk: 9 }],
      preassignments: [
        { amplicon: 'B0', pool: 1 },
        { amplicon: 'B1', pool: 1 },
      ],
    });
    expect(preForbidden.json.feasible === false, 'fixed forbidden pair reported infeasible');
    const fc = preForbidden.json.conflictSummary?.preassignmentConflicts ?? [];
    expect(fc.length === 1, 'one preassignment conflict reported for the fixed forbidden pair');
    expect(
      fc[0] && fc[0].rule === 'forbiddenPair' && fc[0].pool === 1 &&
        new Set(fc[0].members).size === 2 && ['B0', 'B1'].every((m) => fc[0].members.includes(m)) &&
        fc[0].risk === 9,
      'conflict summary names the members, pool, rule and risk',
    );

    // Preloaded pool already over max (aggregate load bounds still pass).
    const preOver = await post({
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
    });
    expect(preOver.json.feasible === false, 'preloaded-over-max pool reported infeasible');
    const oc = preOver.json.conflictSummary?.preassignmentConflicts ?? [];
    expect(
      oc.length === 1 && oc[0].rule === 'poolOverloaded' && oc[0].pool === 1 &&
        ['F0', 'F1', 'F2'].every((m) => oc[0].members.includes(m)),
      'overload summary names the fixed members, pool and poolOverloaded rule',
    );
  } catch (err) {
    expect(false, `API check threw: ${err instanceof Error ? err.stack : err}`);
  }

  let failedChecks = 0;
  for (const c of apiChecks) {
    if (!c.ok) {
      fail('api', c.msg);
      failedChecks++;
    }
  }
  log('api', `${apiChecks.length - failedChecks}/${apiChecks.length} checks passed`);
  if (failedChecks > 0) failures |= 8;
}

/* ---------------------------------- summary ---------------------------------- */
if (failures === 0) {
  log('result', 'ALL STAGES PASSED (build, tests, health, API incl. non-greedy trap)');
} else {
  fail('result', `verification failed with exit mask ${failures} (build=1 tests=2 health=4 api=8)`);
}
process.exit(failures);
