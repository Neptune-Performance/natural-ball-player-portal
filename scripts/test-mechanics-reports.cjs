const { test } = require('node:test');
const assert = require('node:assert/strict');
const { gzipSync } = require('node:zlib');
const { createHandler, decodeDelivery } = require('../api/mechanics-reports');
const id = '11111111-1111-4111-8111-111111111111';
const payload = { schema: 'mechanics-session-report-v1', kind: 'mechanics-session', sessionId: id, athleteName: 'Fixture Athlete', captureDate: '2026-11-11', level: 'college', notes: 'Coach notes', excludedPitchNumbers: [], referenceReview: {}, groups: [{ id: 'group', notes: '', metrics: [], pitchNumbers: [1] }] };
const body = { deliveryId: id, reportId: id, athleteId: id, senderId: id, fingerprint: 'a'.repeat(64), finalizedAt: '2026-11-11T00:00:00Z', payloadGzip: gzipSync(JSON.stringify(payload)).toString('base64') };
function setup(overrides = {}) {
  const calls = [];
  const db = { rpc: async (...args) => { calls.push(['rpc', ...args]); return overrides.rpcResult || { data: id }; }, from: (table) => { calls.push(['from', table]); return chain; } };
  const chain = {};
  for (const method of ['select', 'eq', 'ilike', 'order']) chain[method] = (...args) => { calls.push([method, ...args]); return chain; };
  chain.limit = async n => { calls.push(['limit', n]); return { data: Array.from({ length: 26 }, () => ({ id, full_name: 'Alex', player_profiles: { grad_year: 2028 } })) }; };
  const env = { NBP_MECHANICS_SECRET: 'private-secret', SUPABASE_SERVICE_ROLE_KEY: 'private-key', ...overrides.env };
  const handler = createHandler(() => db, env);
  async function request(extra = {}) {
    const res = { statusCode: 200, headers: {}, setHeader(k, v) { this.headers[k] = v; }, status(n) { this.statusCode = n; return this; }, json(value) { this.body = value; return this; } };
    await handler({ method: 'POST', headers: { authorization: 'Bearer private-secret' }, body, query: {}, ...extra }, res);
    return res;
  }
  return { calls, request };
}
test('rejects unauthorized and unconfigured callers without touching the database', async () => {
  const { calls, request } = setup();
  assert.equal((await request({ headers: {} })).statusCode, 401);
  assert.equal((await request({ headers: { authorization: 'Bearer wrong' } })).statusCode, 401);
  assert.equal(calls.length, 0);
  assert.equal((await setup({ env: { NBP_MECHANICS_SECRET: '' } }).request()).statusCode, 503);
});
test('receives the complete compressed snapshot and returns an opaque receipt', async () => {
  const { calls, request } = setup(); const res = await request();
  assert.equal(res.statusCode, 200); assert.deepEqual(res.body, { reportId: id });
  assert.deepEqual(calls[0][2].p_payload, payload); assert.equal(res.headers['Cache-Control'], 'private, no-store');
});
test('bounds search, limits results and exposes only recipient identity', async () => {
  const { calls, request } = setup();
  assert.equal((await request({ method: 'GET', query: { q: 'A' } })).statusCode, 400);
  const res = await request({ method: 'GET', query: { q: 'Alex_%' } });
  assert.equal(res.body.athletes.length, 25); assert.equal(res.body.hasMore, true);
  assert.deepEqual(calls.find(c => c[0] === 'eq'), ['eq', 'role', 'player']);
  assert.deepEqual(calls.find(c => c[0] === 'select'), ['select', 'id,full_name,player_profiles:player_profiles!player_profiles_user_id_fkey(grad_year,position)']);
  assert.deepEqual(calls.find(c => c[0] === 'ilike'), ['ilike', 'full_name', '%Alex\\_\\%%']);
  assert.deepEqual(Object.keys(res.body.athletes[0]), ['id', 'name', 'detail']);
});
test('rejects malformed, unsupported and oversized compressed reports', async () => {
  const { calls, request } = setup();
  for (const changed of [{ ...body, athleteId: 'wrong' }, { ...body, payloadGzip: 'broken' }, { ...body, payloadGzip: gzipSync('{}').toString('base64') }])
    assert.equal((await request({ body: changed })).statusCode, 400);
  assert.throws(() => decodeDelivery({ ...body, payloadGzip: gzipSync('x'.repeat(32_000_001)).toString('base64') }));
  assert.equal(calls.length, 0);
});
test('reports missing recipients, conflicting identities and database failures accurately', async () => {
  for (const [code, status] of [['P0002', 404], ['23505', 409], ['other', 502]])
    assert.equal((await setup({ rpcResult: { error: { code } } }).request()).statusCode, status);
});
