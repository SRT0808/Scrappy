import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { runPurchaseActions } from '../scripts/purchase-actions.js';
import { purchaseWorker } from '../lib/server/purchase-worker.js';

const env = { PURCHASE_WORKER_ENABLED: 'true', RUN_MODE: 'all',
  PURCHASE_DATABASE_URL: 'postgres://worker:fixture@127.0.0.1/test', PURCHASE_DATABASE_CA: 'fixture CA',
  PURCHASE_APP_ORIGIN: 'https://fixture.invalid', NTFY_TOPIC: 'x'.repeat(24),
  GMAIL_USER: 'sender@fixture.invalid', GMAIL_APP_PASSWORD: 'private-fixture', NOTIFY_EMAIL_TO: 'owner@fixture.invalid' };

test('runtime is opt-in and excludes reading/test_notification before constructing adapters', async () => {
  const forbidden = () => { throw Error('must not construct'); };
  for (const config of [{}, { ...env, PURCHASE_WORKER_ENABLED: 'false' },
    ...['reading', 'test_notification', '', 'unknown'].map(RUN_MODE => ({ ...env, RUN_MODE }))]) {
    assert.deepEqual(await runPurchaseActions(config, { database: forbidden, transports: forbidden, worker: forbidden }), { skipped: true });
  }
});

test('all/product recover durable work without needing a reviewed-product count', async () => {
  for (const RUN_MODE of ['all', 'product']) {
    const order: string[] = [];
    const result = await runPurchaseActions({ ...env, RUN_MODE }, {
      database(options) {
        assert.deepEqual(options, { databaseUrl: env.PURCHASE_DATABASE_URL, ca: 'fixture CA' });
        return async () => ({ async query(sql) {
          order.push(sql.includes('ORDER BY l.id') ? 'recalculate' : 'pending deliveries');
          return { rows: [] };
        }, async close() { order.push('close'); } });
      },
      transports(options) {
        assert.equal(options.emailTo, env.NOTIFY_EMAIL_TO);
        assert.equal(options.appOrigin, env.PURCHASE_APP_ORIGIN);
        return { ntfy: async () => assert.fail('no pending event'), email: async () => assert.fail('no pending event') };
      }, worker: purchaseWorker,
    });
    assert.deepEqual(order, ['recalculate', 'close', 'pending deliveries', 'close']);
    assert.deepEqual(result, { skipped: false, recalculations: 0, conflicts: 0, deliveries: 0,
      remaining: { recalculations: false, deliveries: false }, deadlineReached: false });
  }
});

test('runtime propagates infrastructure failure while still discovering independent deliveries', async () => {
  let opens = 0, queries = 0, closes = 0;
  await assert.rejects(runPurchaseActions(env, {
    database: () => async () => {
      if (++opens === 1) throw Error('fixture discovery outage');
      return { async query() { queries++; return { rows: [] }; }, async close() { closes++; } };
    }, transports: () => ({ ntfy: async () => 'sent', email: async () => 'sent' }), worker: purchaseWorker,
  }), /purchase_worker_failed/);
  assert.equal(opens, 2); assert.equal(queries, 1); assert.equal(closes, 1);
});

test('CLI exits nonzero without leaking configuration or raw errors; excluded mode exits cleanly', () => {
  const entry = '.scrappy/api-build/scripts/purchase-actions.js';
  const failed = spawnSync(process.execPath, [entry], { encoding: 'utf8',
    env: { ...process.env, ...env, PURCHASE_DATABASE_URL: '', PURCHASE_DATABASE_CA: 'secret-fixture' } });
  assert.equal(failed.status, 1);
  assert.match(failed.stderr, /Falló el worker/);
  assert.doesNotMatch(failed.stdout + failed.stderr, /secret-fixture|private-fixture|postgres:|Error:|at /);
  const skipped = spawnSync(process.execPath, [entry], { encoding: 'utf8', env: { ...process.env, RUN_MODE: 'reading', PURCHASE_WORKER_ENABLED: 'true' } });
  assert.equal(skipped.status, 0); assert.match(skipped.stdout, /"skipped":true/);
});

// Exercise the actual workflow conditions, including explicit status functions
// that bypass Actions' implicit success() after a failed Python step.
test('Actions order and failure/heartbeat matrix stays coupled to actual workflow expressions', async () => {
  const source = await readFile('.github/workflows/check-prices.yml', 'utf8');
  assert.match(source, /if: github.ref == 'refs\/heads\/main'/);
  assert.match(source, /group: scrappy-check-prices\s+cancel-in-progress: false/);
  assert.match(source, /timeout-minutes: 20/);
  assert.doesNotMatch(source, /continue-on-error:/);
  const steps = source.split(/^      - name: /m).slice(1).map(block => {
    const name = block.split('\n')[0].trim();
    const condition = block.match(/^        if: (.*)(?:\r?\n)/m)?.[1].trim();
    const expression = condition === '>-' ? block.match(/^        if: >-\r?\n((?:          .*\r?\n)+)/m)![1].trim().replace(/\s*\r?\n\s*/g, ' ') : condition;
    return { name, expression, id: block.match(/^        id: (.*)/m)?.[1].trim(), block };
  });
  const names = steps.map(s => s.name);
  const review = names.indexOf('Review products and send notifications');
  const node = names.indexOf('Set up Node for alternatives');
  const build = names.indexOf('Build alternatives runtime');
  const worker = names.indexOf('Recalculate alternatives and deliver pending notices');
  assert.ok(review > 0 && review < node && node < build && build < worker && worker < names.indexOf('Ping heartbeat'));
  assert.match(steps[worker].block, /node \.scrappy\/api-build\/scripts\/purchase-actions.js/);
  assert.match(steps[build].block, /npm ci --no-audit --no-fund\s+npx tsc/);
  assert.match(steps[review].block, /RUN_MODE: \$\{\{ inputs.mode \|\| 'all' \}\}/);
  assert.match(source, /\$\{HEALTHCHECK_URL%\/\}\/fail/);
  for (const mode of ['', 'all', 'product', 'reading', 'test_notification']) {
    for (const enabled of ['', 'true']) {
      for (const broken of ['', 'before review', 'review', 'purchase_node', 'purchase_build', 'worker']) {
        let failed = false;
        const outcomes: Record<string, { outcome: string }> = {};
        const executed: string[] = [];
        for (const step of steps.slice(review)) {
          if (broken === 'before review') failed = true;
          const expr = step.expression;
          const explicitStatus = /\b(success|failure|cancelled|always)\(\)/.test(expr ?? '');
          const allowed = (!failed || explicitStatus) && (expr ? Function('inputs', 'vars', 'steps', 'success', 'failure', 'cancelled', 'always', 'env', `return (${expr})`)(
            { mode }, { PURCHASE_WORKER_ENABLED: enabled }, new Proxy(outcomes, { get: (target, key: string) => target[key] ?? { outcome: 'skipped' } }),
            () => !failed, () => failed, () => false, () => true, { HEALTHCHECK_URL: 'https://hc-ping.com/fixture' }) : true);
          const failure = allowed && (step.id === broken || step.name === 'Recalculate alternatives and deliver pending notices' && broken === 'worker');
          if (allowed) executed.push(step.name);
          if (step.id) outcomes[step.id] = { outcome: allowed ? failure ? 'failure' : 'success' : 'skipped' };
          if (failure) failed = true;
        }
        const eligible = enabled === 'true' && ['', 'all', 'product'].includes(mode) && broken !== 'before review';
        const runsWorker = eligible && !['purchase_node', 'purchase_build'].includes(broken);
        assert.equal(executed.includes(names[worker]), runsWorker, `${mode}/${enabled}/${broken}`);
        assert.equal(executed.includes('Ping heartbeat'), !failed && mode !== 'reading');
        assert.equal(executed.includes('Ping failure'), failed && mode !== 'reading');
        if (broken === 'review') assert.equal(failed, true);
      }
    }
  }
});
