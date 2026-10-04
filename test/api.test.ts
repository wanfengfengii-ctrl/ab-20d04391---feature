import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { server } from '../src/server.js';
import { validateRequest } from '../src/validation.js';
import type { AllocateRequest } from '../src/types.js';

const validBody = (): AllocateRequest => ({
  amplicons: Array.from({ length: 8 }, (_, i) => ({
    name: `A${i}`,
    load: 10,
    isControl: true,
  })),
  poolCount: 2,
  loadRange: { min: 20, max: 60 },
  riskPairs: [],
  hardThreshold: 5,
});

test('validation accepts a well-formed request', () => {
  assert.deepEqual(validateRequest(validBody()), []);
});

test('validation locates specific bad fields', () => {
  const cases: { body: unknown; fields: string[] }[] = [
    { body: null, fields: ['$'] },
    { body: { ...validBody(), amplicons: [] }, fields: ['amplicons'] },
    { body: { ...validBody(), poolCount: 5 }, fields: ['poolCount'] },
    {
      body: { ...validBody(), loadRange: { min: 60, max: 20 } },
      fields: ['loadRange'],
    },
    { body: { ...validBody(), hardThreshold: -1 }, fields: ['hardThreshold'] },
  ];
  for (const { body, fields } of cases) {
    const issues = validateRequest(body);
    assert.ok(issues.length > 0);
    for (const f of fields) assert.ok(issues.some((i) => i.field === f), `missing issue for ${f}`);
  }
});

test('validation pinpoints array indices, duplicates and unknown names', () => {
  const body: any = validBody();
  body.amplicons[2] = { name: 'A0', load: 10, isControl: true }; // duplicate
  body.amplicons[5] = { name: 'bad', load: -3, isControl: 'yes' };
  body.riskPairs = [{ a: 'A0', b: 'GHOST', risk: 2 }, { a: 'A0', b: 'A1', risk: -1 }];
  const issues = validateRequest(body);
  const fields = issues.map((i) => i.field);
  for (const f of [
    'amplicons[2].name',
    'amplicons[5].load',
    'amplicons[5].isControl',
    'riskPairs[0].b',
    'riskPairs[1].risk',
  ]) {
    assert.ok(fields.includes(f), `expected issue at ${f}, got ${fields.join(', ')}`);
  }
});

test('validation accepts well-formed preassignments', () => {
  const body: any = validBody();
  body.preassignments = [
    { amplicon: 'A0', pool: 1 },
    { amplicon: 'A5', pool: 2 },
  ];
  assert.deepEqual(validateRequest(body), []);
});

test('validation localizes malformed preassignments', () => {
  const cases: { pre: unknown; fields: string[] }[] = [
    { pre: 'not-an-array', fields: ['preassignments'] },
    { pre: [], fields: ['preassignments'] },
    { pre: [{ amplicon: 'A0', pool: 1 }, { amplicon: 'A1', pool: 1 }, { amplicon: 'A2', pool: 1 }, { amplicon: 'A3', pool: 1 }, { amplicon: 'A4', pool: 1 }], fields: ['preassignments'] },
    { pre: [42], fields: ['preassignments[0]'] },
    { pre: [{ amplicon: '', pool: 1 }], fields: ['preassignments[0].amplicon'] },
    { pre: [{ amplicon: 'GHOST', pool: 1 }], fields: ['preassignments[0].amplicon'] },
    { pre: [{ amplicon: 'A0', pool: 1 }, { amplicon: 'A0', pool: 2 }], fields: ['preassignments[1].amplicon'] },
    { pre: [{ amplicon: 'A0', pool: '1' }], fields: ['preassignments[0].pool'] },
    { pre: [{ amplicon: 'A0', pool: 0 }], fields: ['preassignments[0].pool'] },
    { pre: [{ amplicon: 'A0', pool: 3 }], fields: ['preassignments[0].pool'] }, // poolCount is 2
  ];
  for (const { pre, fields } of cases) {
    const body: any = validBody();
    body.preassignments = pre;
    const issues = validateRequest(body);
    assert.ok(issues.length > 0, `expected issues for ${JSON.stringify(pre)}`);
    for (const f of fields) {
      assert.ok(
        issues.some((i) => i.field === f),
        `expected issue at ${f} for ${JSON.stringify(pre)}, got ${issues.map((i) => i.field).join(', ')}`,
      );
    }
  }
});

/* --------------------------------- HTTP layer -------------------------------- */

async function startServer(): Promise<number> {
  server.listen(0);
  await once(server, 'listening');
  const addr = server.address();
  if (typeof addr === 'object' && addr) return addr.port;
  throw new Error('no port');
}

async function post(port: number, body: unknown): Promise<{ status: number; json: any }> {
  const res = await fetch(`http://127.0.0.1:${port}/api/pools/allocate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  return { status: res.status, json: await res.json() };
}

test('HTTP: health, success, validation error, infeasible and malformed JSON',
  async () => {
    const port = await startServer();

    const health = await fetch(`http://127.0.0.1:${port}/health`);
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { status: 'ok' });

    const ok = await post(port, validBody());
    assert.equal(ok.status, 200);
    assert.equal(ok.json.feasible, true);
    assert.equal(ok.json.pools.length, 2);
    for (const p of ok.json.pools) {
      assert.ok(Array.isArray(p.controls) && p.controls.length >= 1);
      assert.ok(Array.isArray(p.riskPairs));
      assert.equal(typeof p.load, 'number');
      assert.equal(typeof p.riskSum, 'number');
    }

    const bad = await post(port, { ...validBody(), poolCount: 9 });
    assert.equal(bad.status, 400);
    assert.equal(bad.json.error, 'validation_failed');
    assert.ok(bad.json.issues.some((i: any) => i.field === 'poolCount'));

    const infeasible = validBody();
    infeasible.poolCount = 4;
    infeasible.amplicons.forEach((a) => (a.isControl = false));
    infeasible.amplicons[0]!.isControl = true;
    const r2 = await post(port, infeasible);
    assert.equal(r2.status, 200);
    assert.equal(r2.json.feasible, false);
    assert.equal(r2.json.conflictSummary.poolsWithoutControl, 3);

    const malformed = await post(port, '{not json');
    assert.equal(malformed.status, 400);
    assert.equal(malformed.json.error, 'invalid_request');

    const nf = await fetch(`http://127.0.0.1:${port}/nope`);
    assert.equal(nf.status, 404);

    /* ------------------------- preassignment over HTTP ------------------------- */

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
    const unconstrained = await post(port, trap);
    assert.equal(unconstrained.json.feasible, true);

    // A pre-installed position is respected and reshuffles the optimal layout.
    const pinned = await post(port, { ...trap, preassignments: [{ amplicon: 'a', pool: 1 }] });
    assert.equal(pinned.status, 200);
    assert.equal(pinned.json.feasible, true);
    const pinnedWhere = new Map(pinned.json.assignment.map((x: any) => [x.amplicon, x.pool]));
    assert.equal(pinnedWhere.get('a'), 1, 'pinned amplicon stays in its pool');
    const plainWhere = new Map(unconstrained.json.assignment.map((x: any) => [x.amplicon, x.pool]));
    assert.notDeepEqual(
      pinned.json.assignment.map((x: any) => x.pool),
      unconstrained.json.assignment.map((x: any) => x.pool),
      'the pre-installed position changes the optimal allocation',
    );
    assert.equal(plainWhere.get('a'), 2, 'sanity: unconstrained optimum puts a in pool 2');
    assert.equal(pinned.json.maxPoolRisk, 0);
    assert.equal(pinned.json.loadSpread, 0);

    // A pre-installed forbidden pair proves infeasibility and is reported.
    const conflict = await post(port, {
      ...trap,
      preassignments: [
        { amplicon: 'X', pool: 1 },
        { amplicon: 'Y', pool: 1 },
      ],
    });
    assert.equal(conflict.status, 200);
    assert.equal(conflict.json.feasible, false);
    const preConflicts = conflict.json.conflictSummary?.preassignmentConflicts ?? [];
    assert.ok(
      preConflicts.some(
        (c: any) => c.pool === 1 && c.members.includes('X') && c.members.includes('Y'),
      ),
      `expected a preassignment conflict for X/Y in pool 1, got ${JSON.stringify(preConflicts)}`,
    );

    // Invalid preassignments are rejected with field-located issues.
    const badPre = await post(port, {
      ...validBody(),
      preassignments: [{ amplicon: 'GHOST', pool: 9 }],
    });
    assert.equal(badPre.status, 400);
    const badPreFields = new Set((badPre.json.issues ?? []).map((i: any) => i.field));
    assert.ok(badPreFields.has('preassignments[0].amplicon'));
    assert.ok(badPreFields.has('preassignments[0].pool'));

    after(() => server.close());
  });
