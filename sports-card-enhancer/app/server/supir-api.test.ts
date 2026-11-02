import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { authorized, createHandler, validateInput, type Query, type Transaction } from './supir-api.js';

const token = 'test-only-token-01234567890123456789';
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZQmcAAAAASUVORK5CYII=';
const input = { image: png, filename: '../../card.png', model: 'F', scale: 1, seed: 1234 };

function setup(env: Record<string, string> = { SUPIR_DATABASE_URL: 'test', SUPIR_API_TOKEN: token }) {
  const calls: { sql: string; values?: unknown[] }[] = [];
  const query: Query = async (sql, values) => {
    calls.push({ sql, values });
    return sql.includes('AS online') ? [{ online: false }] : [];
  };
  const transaction: Transaction = async queries => {
    queries.forEach(q => calls.push({ sql: q.text, values: q.values }));
    return queries.map(q => q.text.includes('RETURNING id,status') ? [{ id: 'job-id', status: 'pending' }] : []);
  };
  return { calls, handler: createHandler(query, transaction, env) };
}
async function invoke(handler: ReturnType<typeof createHandler>, action: string, method = 'GET', body?: unknown, auth: string | undefined = `Bearer ${token}`, id?: string) {
  let code = 0; let result: unknown;
  const headers: Record<string, unknown> = {};
  const res = { setHeader(k: string, v: unknown) { headers[k] = v; }, status(n: number) { code = n; return this; },
    json(b: unknown) { result = b; return this; }, send(b: unknown) { result = b; return this; } };
  await handler({ query: { action, id }, method, body, headers: { authorization: auth } } as unknown as VercelRequest, res as unknown as VercelResponse);
  return { code, result, headers };
}

test('constant-time token check rejects missing, short and wrong tokens', () => {
  assert.equal(authorized(`Bearer ${token}`, token), true);
  for (const value of [undefined, '', 'Bearer wrong', ['Bearer ' + token]]) assert.equal(authorized(value, token), false);
  assert.equal(authorized('Bearer short', 'short'), false);
});
test('input enforces format, bounded payload and constrained inference parameters', () => {
  assert.equal(validateInput(input).filename, '.._.._card.png');
  for (const bad of [null, { ...input, image: 'not-an-image' }, { ...input, image: Buffer.from('no').toString('base64') },
    { ...input, image: 'A'.repeat(3 * 1024 * 1024) }, { ...input, model: 'shell;command' },
    { ...input, scale: 4 }, { ...input, seed: -1 }, { ...input, seed: 1.5 }]) assert.throws(() => validateInput(bad));
});
test('unauthorized requests cannot access the database or images', async () => {
  const { handler, calls } = setup();
  const response = await invoke(handler, 'jobs', 'GET', undefined, 'Bearer invalid');
  assert.equal(response.code, 401); assert.equal(calls.length, 0);
  assert.equal(response.headers['Cache-Control'], 'no-store');
});
test('missing token fails closed, without touching Neon', async () => {
  const { handler, calls } = setup({ SUPIR_DATABASE_URL: 'test' });
  assert.equal((await invoke(handler, 'jobs', 'POST', input)).code, 503);
  assert.equal(calls.length, 0);
});
test('health distinguishes Neon, token configuration and GPU availability', async () => {
  const { handler } = setup();
  const response = await invoke(handler, 'health');
  assert.deepEqual(response.result, { database: 'connected', worker: false, accessConfigured: true, namespace: 'preview' });
});
test('submission is durable, parameterized, namespace-scoped and queue-bounded', async () => {
  const { handler, calls } = setup();
  assert.equal((await invoke(handler, 'jobs', 'POST', input)).code, 202);
  const insert = calls.find(c => c.sql.includes('RETURNING id,status'));
  assert.equal(insert?.values?.[1], 'preview');
  assert.ok(insert?.sql.includes('< 5'));
  assert.ok(calls.some(c => c.sql.includes('FOR UPDATE')));
  assert.ok(!insert?.sql.includes(png));
});
test('queue saturation returns 429', async () => {
  const handler = createHandler(async () => [], async q => q.map(() => []), { SUPIR_DATABASE_URL: 'test', SUPIR_API_TOKEN: token });
  assert.equal((await invoke(handler, 'jobs', 'POST', input)).code, 429);
});
test('database failures are sanitized', async () => {
  const handler = createHandler(async () => { throw new Error('private-secret'); }, async q => q.map(() => []), { SUPIR_DATABASE_URL: 'test' });
  const response = await invoke(handler, 'health');
  assert.equal(response.code, 503); assert.ok(!JSON.stringify(response.result).includes('private-secret'));
});
test('production is isolated from preview', async () => {
  const { handler, calls } = setup({ SUPIR_DATABASE_URL: 'test', SUPIR_API_TOKEN: token, VERCEL_ENV: 'production' });
  await invoke(handler, 'jobs');
  assert.equal(calls.at(-1)?.values?.[0], 'production');
});
test('unsupported methods are rejected', async () => {
  const { handler } = setup();
  assert.equal((await invoke(handler, 'jobs', 'DELETE')).code, 405);
});
test('invalid result identifiers are rejected before a database query', async () => {
  const { handler, calls } = setup();
  const response = await invoke(handler, 'result', 'GET', undefined, `Bearer ${token}`, '-'.repeat(36));
  assert.equal(response.code, 400); assert.equal(calls.length, 0);
});
test('downloads require a completed job in the same namespace and use no-store', async () => {
  let params: unknown[] | undefined;
  const handler = createHandler(async (text, values) => {
    assert.ok(text.includes("namespace=$2 AND status='completed'"));
    params = values;
    return [{ output_base64: Buffer.from('mock-jpeg').toString('base64') }];
  }, async q => q.map(() => []), { SUPIR_DATABASE_URL: 'test', SUPIR_API_TOKEN: token });
  const id = '00000000-0000-4000-8000-000000000001';
  const response = await invoke(handler, 'result', 'GET', undefined, `Bearer ${token}`, id);
  assert.equal(response.code, 200); assert.deepEqual(params, [id, 'preview']);
  assert.deepEqual(response.result, Buffer.from('mock-jpeg'));
  assert.equal(response.headers['Cache-Control'], 'no-store');
  assert.equal(response.headers['Content-Type'], 'image/jpeg');
});
