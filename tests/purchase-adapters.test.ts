import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:net';
import nodemailer from 'nodemailer';
import { purchaseDatabaseConfig, purchasePostgres } from '../lib/server/purchase-postgres.js';
import { purchaseTransports, renderPurchaseNotice, type PurchaseProviders } from '../lib/server/purchase-transports.js';

const budget = { connectTimeoutMs: 9000, queryTimeoutMs: 9000, remainingMs: () => 8000 };
const databaseUrl = 'postgresql://worker:private@db.example.test/scrappy';
const options = { appOrigin: 'https://scrappy.example.test', ntfyTopic: 'a'.repeat(24),
  gmailUser: 'sender@example.test', gmailPassword: 'private', emailTo: 'owner@example.test' };
const event = { eventId: '11111111-1111-4111-8111-111111111111', listId: '22222222-2222-4222-8222-222222222222',
  configurationVersion: '9007199254740993', evaluatedAt: '2026-10-16T12:30:00.123456+00:00' };
const notice = { title: 'Aviso de alternativas de Scrappy', message: 'Presupuesto alcanzado: 10 PEN.',
  basketPath: `/?basket=${event.listId}`, offers: [] };
const context = () => ({ ...event, signal: new AbortController().signal, timeoutMs: 15 });

test('PostgreSQL config verifies TLS, bounds timeouts and prevents URL/env overrides', () => {
  const config = purchaseDatabaseConfig({ databaseUrl, ca: 'PEM fixture' }, budget);
  assert.deepEqual(config.ssl, { rejectUnauthorized: true, ca: 'PEM fixture' });
  assert.equal(config.connectionTimeoutMillis, 5000); assert.equal(config.query_timeout, 2000);
  assert.equal(config.statement_timeout, 2000); assert.equal(config.options, '-c search_path=pg_catalog,public');
  assert.equal(config.user, 'worker'); assert.equal(config.application_name, 'scrappy-purchase-worker');
  for (const suffix of ['?sslmode=disable', '?options=-c%20statement_timeout=0', '?sslrootcert=x', '#fragment'])
    assert.throws(() => purchaseDatabaseConfig({ databaseUrl: databaseUrl + suffix }, budget));
  for (const user of ['postgres', 'service_role', 'supabase_admin'])
    assert.throws(() => purchaseDatabaseConfig({ databaseUrl: databaseUrl.replace('worker:', user + ':') }, budget));
  assert.throws(() => purchaseDatabaseConfig({ databaseUrl, localFixture: true }, budget));
  assert.throws(() => purchaseDatabaseConfig({ databaseUrl }, { ...budget, remainingMs: () => 0 }));
  assert.equal(purchaseDatabaseConfig({ databaseUrl: 'postgres://worker:x@127.0.0.1/test', localFixture: true }, budget).ssl, false);
});

test('session cleanup is bounded even if driver end never completes', async () => {
  const client = { on() {}, async connect() {}, async query() { return { rows: [{ allowed: true }] }; },
    end() { return new Promise<void>(() => {}); } };
  const connect = purchasePostgres({ databaseUrl }, () => client as never);
  const db = await connect({ ...budget, queryTimeoutMs: 20 });
  const first = db.close(); assert.equal(db.close(), first);
  await assert.rejects(first, /purchase_database_close_timeout/);
});

test('driver receives explicit PGOPTIONS/TLS overrides and requires URL credentials', () => {
  process.env.PGOPTIONS = '-c role=postgres';
  try {
    const config = purchaseDatabaseConfig({ databaseUrl }, budget);
    assert.notEqual(config.options, process.env.PGOPTIONS);
    assert.equal(config.sslnegotiation, 'postgres');
    assert.throws(() => purchaseDatabaseConfig({ databaseUrl: 'postgres://worker@db.example.test/db' }, budget));
  } finally { delete process.env.PGOPTIONS; }
});

test('session closes on unsafe login and connection failure without queries/retries', async () => {
  for (const failure of ['role', 'connect']) {
    let closed = 0, calls = 0;
    const client = { on() {}, async connect() { if (failure === 'connect') throw Error('fixture outage'); },
      async query() { calls++; return { rows: [{ allowed: false }] }; }, async end() { closed++; } };
    const connect = purchasePostgres({ databaseUrl }, () => client as never);
    await assert.rejects(connect(budget)); assert.equal(closed, 1); assert.equal(calls, failure === 'role' ? 1 : 0);
  }
});

test('message preserves frozen event identity, exact version/date and validated current-basket link', () => {
  const message = renderPurchaseNotice(options.appOrigin, notice, event);
  for (const text of ['histórica', event.eventId, event.configurationVersion, event.evaluatedAt, notice.message])
    assert.ok(message.text.includes(text));
  assert.equal(message.link, options.appOrigin + notice.basketPath);
  for (const origin of ['http://example.test', 'https://example.test/path', 'https://user:pass@example.test', 'https://example.test/?a=b'])
    assert.throws(() => purchaseTransports({ ...options, appOrigin: origin }));
  assert.throws(() => renderPurchaseNotice(options.appOrigin, { ...notice, basketPath: '//evil.test/' }, event));
});

test('ntfy acceptance requires receipt; definite rejections differ from uncertain provider results', async () => {
  for (const [status, receipt, expected] of [
    [200, { event: 'message', id: 'receipt' }, 'sent'], [200, {}, 'ambiguous'],
    [403, {}, 'failed'], [429, {}, 'failed'], [408, {}, 'ambiguous'], [500, {}, 'ambiguous'],
  ] as const) {
    const providers: PurchaseProviders = { fetch: async (url, init) => {
      assert.equal(url, 'https://ntfy.sh/'); assert.equal(init?.redirect, 'error');
      assert.equal(JSON.parse(String(init?.body)).click, options.appOrigin + notice.basketPath);
      assert.ok(init?.signal); return new Response(JSON.stringify(receipt), { status });
    }, smtp: () => { throw Error('unexpected email'); } };
    assert.equal(await purchaseTransports(options, providers).ntfy(notice, context()), expected);
  }
  const channels = purchaseTransports(options, { fetch: async () => { throw Error('lost response'); }, smtp: () => { throw Error(); } });
  assert.equal(await channels.ntfy(notice, context()), 'ambiguous');
});

test('SMTP acceptance, rejection, uncertain errors and abort always close the transport', async () => {
  for (const scenario of ['accept', 'reject', 'partial', 'error', 'definite', 'abort'] as const) {
    let closes = 0;
    const controller = new AbortController();
    const providers: PurchaseProviders = { fetch: async () => { throw Error(); }, smtp: timeout => {
      assert.equal(timeout, 15);
      return { close() { closes++; }, async sendMail(message) {
        assert.ok(message.text.includes(event.evaluatedAt));
        if (scenario === 'abort') { controller.abort(); throw Error('closed'); }
        if (scenario === 'error') throw Error('unknown outcome');
        if (scenario === 'definite') throw Object.assign(Error('rejected'), { responseCode: 550 });
        return { accepted: scenario === 'reject' ? [] : [options.emailTo], rejected: scenario === 'accept' ? [] : [options.emailTo] };
      } };
    } };
    const result = await purchaseTransports(options, providers).email(notice, { ...context(), signal: controller.signal });
    assert.equal(result, scenario === 'accept' ? 'sent' : ['reject', 'definite'].includes(scenario) ? 'failed' : 'ambiguous');
    assert.ok(closes > 0);
  }
});

test('runtime SMTP defaults verify TLS, bound every timeout and disable file/URL access', async () => {
  const original = nodemailer.createTransport;
  let closed = false;
  nodemailer.createTransport = ((config: Record<string, unknown>) => {
    assert.equal(config.host, 'smtp.gmail.com'); assert.equal(config.port, 465); assert.equal(config.secure, true);
    assert.deepEqual(config.tls, { rejectUnauthorized: true });
    for (const key of ['connectionTimeout', 'greetingTimeout', 'socketTimeout']) assert.equal(config[key], 15);
    assert.equal(config.disableFileAccess, true); assert.equal(config.disableUrlAccess, true);
    return { async sendMail() { return { accepted: [options.emailTo], rejected: [] }; }, close() { closed = true; } };
  }) as unknown as typeof nodemailer.createTransport;
  try { assert.equal(await purchaseTransports(options).email(notice, context()), 'sent'); assert.equal(closed, true); }
  finally { nodemailer.createTransport = original; }
});

test('ntfy response arriving after cancellation remains ambiguous', async () => {
  const controller = new AbortController();
  const channels = purchaseTransports(options, { fetch: async () => {
    controller.abort(); return new Response(JSON.stringify({ event: 'message', id: 'late' }));
  }, smtp: () => { throw Error('unexpected'); } });
  assert.equal(await channels.ntfy(notice, { ...context(), signal: controller.signal }), 'ambiguous');
});

test('unresponsive local PostgreSQL handshake reaches connect timeout and releases the socket', async () => {
  const sockets = new Set<import('node:net').Socket>();
  const server = createServer(socket => { sockets.add(socket); socket.on('error', () => {}); socket.on('close', () => sockets.delete(socket)); });
  await new Promise<void>(ok => server.listen(0, '127.0.0.1', ok));
  try {
    const port = (server.address() as import('node:net').AddressInfo).port;
    const connect = purchasePostgres({ databaseUrl: `postgres://worker:fixture@127.0.0.1:${port}/fixture`, localFixture: true });
    await assert.rejects(connect({ ...budget, connectTimeoutMs: 50 }), /timeout/);
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>(ok => server.close(() => ok()));
  }
});
