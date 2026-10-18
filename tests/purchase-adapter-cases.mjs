import assert from 'node:assert/strict';
import { createServer as httpServer } from 'node:http';
import { createServer as smtpServer } from 'node:net';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import nodemailer from 'nodemailer';
import { purchasePostgres } from '../.scrappy/api-build/lib/server/purchase-postgres.js';
import { purchaseTransports } from '../.scrappy/api-build/lib/server/purchase-transports.js';
import { purchaseWorker } from '../.scrappy/api-build/lib/server/purchase-worker.js';
import { savePurchaseConfiguration } from '../.scrappy/api-build/lib/server/purchase-persistence.js';
import { localPurchaseRuntime } from '../.scrappy/api-build/scripts/local-purchase-runtime.js';

export async function runAdapterCases({ admin, value, row, list, product, literal, port, psql, args }) {
  let cases = 0;
  const test = async (name, work) => {
    if (process.env.PURCHASE_ADAPTERS_MATCH && !new RegExp(process.env.PURCHASE_ADAPTERS_MATCH).test(name)) return;
    await work(); cases++; console.log('PASS adapters: ' + name);
  };
  await admin.query('CREATE ROLE purchase_fixture LOGIN NOINHERIT; GRANT service_role TO purchase_fixture');
  const databaseUrl = `postgres://purchase_fixture:fixture@127.0.0.1:${port}/postgres`;
  const connect = purchasePostgres({ databaseUrl, localFixture: true });
  const budget = { connectTimeoutMs: 5000, queryTimeoutMs: 2000, remainingMs: () => 180000 };
  const counts = () => value(`select jsonb_build_object('checks',(select count(*) from price_checks),
    'legacy',(select count(*) from basket_snapshots),'notifications',(select count(*) from notifications),
    'evaluations',(select count(*) from purchase_evaluations))`);
  const baseline = await counts();
  await test('real pg exclusive sessions, parameter binding, serializable rollback and restricted service role', async () => {
    const db = await connect(budget), other = await connect(budget);
    try {
      const identity = (await db.query('select session_user,current_user,pg_backend_pid() as pid')).rows[0];
      assert.equal(identity.session_user, 'purchase_fixture'); assert.equal(identity.current_user, 'service_role');
      assert.notEqual(identity.pid, (await other.query('select pg_backend_pid() as pid')).rows[0].pid);
      const hostile = "'); drop table products; --";
      assert.equal((await db.query('select $1::text as value', [hostile])).rows[0].value, hostile);
      await db.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
      assert.equal((await db.query('show transaction_isolation')).rows[0].transaction_isolation, 'serializable');
      await assert.rejects(db.query('update public.products set last_price=0'), e => e.code === '42501');
      await db.query('ROLLBACK'); assert.equal((await db.query('select 1 as value')).rows[0].value, 1);
    } finally { await db.close(); await db.close(); await other.close(); }
  });
  await test('elevated, inheriting, owner and unrelated-membership logins fail closed; SQL timeout rolls back', async () => {
    for (const change of ['SUPERUSER', 'INHERIT', 'CREATEDB', 'CREATEROLE', 'REPLICATION', 'BYPASSRLS']) {
      await admin.query('ALTER ROLE purchase_fixture ' + change);
      await assert.rejects(connect(budget), /unsafe_purchase_database_role/);
      await admin.query('ALTER ROLE purchase_fixture NO' + change);
    }
    await admin.query('CREATE TABLE public.fixture_owned(i int); ALTER TABLE public.fixture_owned OWNER TO purchase_fixture');
    await assert.rejects(connect(budget), /unsafe_purchase_database_role/);
    await admin.query('DROP TABLE public.fixture_owned; CREATE ROLE unrelated_fixture; GRANT unrelated_fixture TO purchase_fixture');
    await assert.rejects(connect(budget), /unsafe_purchase_database_role/);
    await admin.query('REVOKE unrelated_fixture FROM purchase_fixture');
    const db = await connect({ ...budget, queryTimeoutMs: 80 });
    try {
      await db.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
      await assert.rejects(db.query('select pg_sleep(1)'));
    } finally { await db.close(); }
    assert.equal(await value("select count(*)::int from pg_stat_activity where usename='purchase_fixture' and state='idle in transaction'"), 0);
    // TLS is compulsory outside the explicit fixture, even on loopback.
    await assert.rejects(purchasePostgres({ databaseUrl })(budget), /SSL/);
  });
  await test('membership cannot inherit/administer service_role, and PGOPTIONS cannot change the session role', async () => {
    for (const flag of ['INHERIT', 'ADMIN']) {
      await admin.query(`GRANT service_role TO purchase_fixture WITH ${flag} TRUE`);
      await assert.rejects(connect(budget), /unsafe_purchase_database_role/);
      await admin.query(`GRANT service_role TO purchase_fixture WITH ${flag} FALSE`);
    }
    const prior = process.env.PGOPTIONS;
    process.env.PGOPTIONS = '-c role=postgres';
    try {
      const db = await connect(budget);
      try { assert.equal((await db.query('select current_user')).rows[0].current_user, 'service_role'); }
      finally { await db.close(); }
    } finally { if (prior === undefined) delete process.env.PGOPTIONS; else process.env.PGOPTIONS = prior; }
  });

  let providerMode = 'accept', httpCalls = 0, mailCalls = 0;
  const messages = [], sockets = new Set();
  const http = httpServer(async (req, res) => {
    httpCalls++; let body = ''; for await (const chunk of req) body += chunk;
    messages.push(JSON.parse(body));
    if (providerMode === 'timeout') return;
    res.writeHead(providerMode === 'reject' ? 403 : 200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ event: 'message', id: 'fixture-receipt' }));
  });
  const smtp = smtpServer(socket => {
    sockets.add(socket); socket.on('close', () => sockets.delete(socket)); socket.on('error', () => {});
    socket.write('220 fixture ESMTP\r\n'); let buffer = '', data = false;
    socket.on('data', chunk => {
      buffer += chunk.toString();
      while (buffer.includes('\r\n')) {
        const index = buffer.indexOf('\r\n'), line = buffer.slice(0, index); buffer = buffer.slice(index + 2);
        if (data) {
          if (line === '.') { data = false; mailCalls++; if (providerMode !== 'timeout') socket.write('250 queued\r\n'); }
        } else if (/^EHLO|^HELO/.test(line)) socket.write('250 fixture\r\n');
        else if (/^MAIL/.test(line)) socket.write('250 ok\r\n');
        else if (/^RCPT/.test(line)) socket.write(providerMode === 'reject' ? '550 rejected\r\n' : '250 ok\r\n');
        else if (line === 'DATA') { data = true; socket.write('354 go\r\n'); }
        else if (line === 'QUIT') socket.end('221 bye\r\n');
        else socket.write('250 ok\r\n');
      }
    });
  });
  await new Promise(ok => http.listen(0, '127.0.0.1', ok));
  await new Promise(ok => smtp.listen(0, '127.0.0.1', ok));
  const options = { appOrigin: 'https://scrappy.example.test', ntfyTopic: 'f'.repeat(24),
    gmailUser: 'sender@example.test', gmailPassword: 'fixture', emailTo: 'owner@example.test' };
  const channels = purchaseTransports(options, {
    fetch: (_url, init) => fetch(`http://127.0.0.1:${http.address().port}/`, init),
    smtp: timeoutMs => nodemailer.createTransport({ host: '127.0.0.1', port: smtp.address().port, secure: false,
      ignoreTLS: true, connectionTimeout: timeoutMs, greetingTimeout: timeoutMs, socketTimeout: timeoutMs,
      disableFileAccess: true, disableUrlAccess: true }),
  });
  const worker = extra => purchaseWorker({ connect, channels, now: Date.now, ...extra });
  const config = { schema_version: 2, currency: 'PEN', budget: '100', budget_enabled: true, winner_enabled: false, minimum_savings: '0',
    needs: [{ id: list(1), name: 'Fixture unit', required_quantity: '1', unit: 'unit', position: 0, allow_surplus: false }],
    offers: [{ id: product(2), product_id: product(2), max_purchase_units: null, coverage: [{ need_id: list(1), quantity: '1' }], extras: [] }],
    alternatives: [{ id: list(2), name: 'Fixture', position: 0, scope: [list(1)], items: [{ offer_id: product(2), purchase_units: 1 }] }], pins: [], reference: [] };
  let runtime, root;
  try {
    await test('fake HTTP/SMTP accept, reject and time out without remote access', async () => {
      const event = { eventId: list(3), listId: list(1), configurationVersion: '2', evaluatedAt: '2026-10-16T12:30:00Z' };
      const notice = { title: 'Aviso de alternativas de Scrappy', message: 'Presupuesto alcanzado.', basketPath: `/?basket=${list(1)}`, offers: [] };
      for (providerMode of ['accept', 'reject', 'timeout']) {
        for (const channel of ['ntfy', 'email']) {
          const controller = new AbortController(), timer = setTimeout(() => controller.abort(), providerMode === 'timeout' ? 100 : 3000);
          try {
            const pending = channels[channel](notice, { ...event, signal: controller.signal, timeoutMs: providerMode === 'timeout' ? 80 : 2000 });
            // The worker owns the total deadline; adapters abort their I/O.
            const result = await Promise.race([pending, new Promise(ok => controller.signal.addEventListener('abort', () => ok('ambiguous'), { once: true }))]);
            assert.equal(result, providerMode === 'accept' ? 'sent' : providerMode === 'reject' ? 'failed' : 'ambiguous');
          } finally { clearTimeout(timer); }
        }
      }
    });
    providerMode = 'accept';
    await test('worker uses pg and frozen Spanish provider messages; concurrent opt-in recovery does not replay', async () => {
      await admin.query("update fixture_clock set at_time='2026-10-16 12:35Z'");
      await savePurchaseConfiguration(admin, list(1), String((await row(1)).configuration_version), config);
      const w = worker(); const a = w.recover(), b = w.afterProductReview(); assert.equal(a, b);
      const report = await a;
      assert.ok(report.recalculations.some(o => o.disposition === 'committed'));
      assert.ok(report.deliveries.some(d => d.outcomes.ntfy === 'sent' && d.outcomes.email === 'sent'));
      const frozen = messages.findLast(m => m.click === options.appOrigin + `/?basket=${list(1)}`);
      assert.equal(frozen.click, options.appOrigin + `/?basket=${list(1)}`);
      for (const text of ['histórica', 'Evento:', 'Versión de configuración:', 'Fecha de evaluación:']) assert.ok(frozen.message.includes(text));
      const before = [httpCalls, mailCalls, await counts()];
      await worker().recover(); assert.deepEqual([httpCalls, mailCalls, await counts()], before);
    });
    await test('failed Python child after saved review invokes real worker; callback outage survives restart', async () => {
      root = await mkdtemp(resolve('.scrappy/local-adapter-review-'));
      await symlink(resolve('.venv'), resolve(root, '.venv'), process.platform === 'win32' ? 'junction' : 'dir');
      await mkdir(resolve(root, 'scraper/src/scrappy'), { recursive: true });
      await writeFile(resolve(root, 'scraper/src/scrappy/__init__.py'), `__path__.append(${JSON.stringify(resolve('scraper/src/scrappy'))})`);
      await writeFile(resolve(root, 'scraper/src/scrappy/run.py'), await readFile('tests/fixtures/local-purchase-review.py'));
      async function review(at, failConnection) {
        await writeFile(resolve(root, 'fixture.json'), JSON.stringify({ ok: true, at, crash_after_save: true, psql, args, runner: resolve('scraper/src/scrappy/run.py') }));
        let completed;
        const done = new Promise(ok => { completed = ok; });
        runtime = localPurchaseRuntime(root, { channels, now: Date.now, connect: async budget => {
          if (failConnection) { completed(); throw Error('fixture database outage'); }
          const db = await connect(budget);
          return { query: db.query, async close() { await db.close(); completed(); } };
        } });
        await runtime.dispatchProduct(product(2)); await runtime.dispatchProduct(product(2));
        let timer;
        try { await Promise.race([done, new Promise((_, reject) => { timer = setTimeout(() => reject(Error('callback timeout')), 15000); })]); }
        finally { clearTimeout(timer); runtime.close(); }
      }
      const before = await counts();
      await review('2026-10-16T12:31:00+00:00', false);
      // Wait for completion of both worker sweeps, using the coalesced promise.
      await runtime.recover();
      assert.equal((await row(1)).dirty, false);
      await review('2026-10-16T12:32:00+00:00', true);
      assert.equal((await row(1)).dirty, true);
      const restarted = localPurchaseRuntime(root, { connect, channels, now: Date.now });
      try { await restarted.recover(); await restarted.recover(); } finally { restarted.close(); }
      const after = await counts(); assert.equal(after.checks, before.checks + 2);
      assert.equal(after.evaluations, before.evaluations + 2);
      assert.equal((await row(1)).dirty, false);
    });
    const after = await counts();
    assert.equal(after.legacy, baseline.legacy); assert.equal(after.notifications, baseline.notifications);
    assert.equal(after.checks, baseline.checks + 2);
  } finally {
    runtime?.close();
    http.closeAllConnections(); await new Promise(ok => http.close(ok));
    for (const socket of sockets) socket.destroy(); await new Promise(ok => smtp.close(ok));
    if (root) {
      if (!root.startsWith(resolve('.scrappy') + sep)) throw Error('Unsafe fixture directory');
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  }
  return cases;
}
