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

    after(() => server.close());
  });
