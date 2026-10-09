import { readFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import assert from 'node:assert/strict';

const token = process.env.SUPABASE_ACCESS_TOKEN;
const ref = new URL(process.env.SUPABASE_URL).hostname.split('.')[0];
if (!token) throw new Error('Configure SUPABASE_ACCESS_TOKEN for the transactional SQL test');
const migration = (await readFile('supabase/migrations/20261008030000_login_attempts.sql', 'utf8'))
  .replace(/^begin;\s*/, '').replace(/commit;\s*$/, '');
const assertions = await readFile('tests/fixtures/login-attempts.sql', 'utf8');
const installed = process.argv.includes('--installed');

async function query(sql) {
  const response = await fetch(`https://api.supabase.com/v1/projects/${ref}/database/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: sql }),
    signal: AbortSignal.timeout(30000),
  });
  if (!response.ok) {
    let diagnostic = await response.text();
    for (const name of ['SUPABASE_ACCESS_TOKEN', 'SUPABASE_SERVICE_ROLE_KEY', 'ACCESS_KEY', 'SESSION_SECRET']) {
      const secret = process.env[name];
      if (secret) diagnostic = diagnostic.replaceAll(secret, '[redacted]');
    }
    throw new Error(`Login SQL assertions failed (HTTP ${response.status}): ${diagnostic.slice(0, 1500)}`);
  }
  return response.json();
}

await query(`begin;\n${installed ? '' : migration}\n${assertions}\nrollback;`);
console.log(`Login SQL assertions passed; ${installed ? 'fixtures' : 'migration and fixtures'} rolled back.`);

if (installed) {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) throw new Error('Configure SUPABASE_SERVICE_ROLE_KEY for concurrent RPC tests');
  // Random documentation-only addresses avoid changing real login history.
  const suffix = randomBytes(8).toString('hex').match(/.{4}/g).join(':');
  const ip = `2001:db8::${suffix}`;
  const expandedIp = `2001:0db8:0000:0000:${suffix}`;
  const otherIp = `2001:db8:1:0:${suffix}`;
  async function attempt(address, success = false) {
    const response = await fetch(new URL('/rest/v1/rpc/record_login_attempt', process.env.SUPABASE_URL), {
      method: 'POST',
      headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ p_ip: address, p_success: success }),
      signal: AbortSignal.timeout(30000),
    });
    assert.equal(response.status, 200, 'Service-role RPC failed');
    const retry = await response.json();
    assert.ok(Number.isInteger(retry) && retry >= 0 && retry <= 900, 'Invalid Retry-After');
    return retry;
  }
  try {
    // Each HTTP request uses its own database transaction. Wait for every request
    // to settle before cleanup, even when one fails.
    const pending = Array.from({ length: 12 }, (_, i) => attempt(i % 2 ? ip : expandedIp, i % 2 === 0));
    pending.push(attempt(otherIp));
    const results = await Promise.allSettled(pending);
    const failure = results.find(result => result.status === 'rejected');
    if (failure) throw failure.reason;
    const retries = results.slice(0, 12).map(result => result.value);
    assert.equal(retries.filter(retry => retry === 0).length, 5, 'Must admit exactly five concurrent attempts');
    assert.equal(retries.filter(retry => retry > 0).length, 7, 'Must block the other seven attempts');
    assert.equal(results[12].value, 0, 'A different IP must remain independent');
    assert.ok(await attempt(ip, true) > 0, 'Correct key must not bypass an exhausted limit');
    const rows = await query(`select count(*)::integer as count from public.login_attempts where ip = '${ip}'::inet;`);
    assert.equal(rows[0].count, 5, 'Blocked attempts must not create rows');
    console.log('Concurrent service-role RPCs passed: 5 admitted, 7 blocked; equivalent IPv6 and separate IP verified.');
  } finally {
    await query(`delete from public.login_attempts where ip in ('${ip}'::inet, '${otherIp}'::inet);`);
    const rows = await query(`select count(*)::integer as count from public.login_attempts where ip in ('${ip}'::inet, '${otherIp}'::inet);`);
    assert.equal(rows[0].count, 0, 'Concurrent fixtures must be removed');
    console.log('Concurrent fixtures removed.');
  }
}
