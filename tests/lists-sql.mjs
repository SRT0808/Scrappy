import { readFile } from 'node:fs/promises';

const token = process.env.SUPABASE_ACCESS_TOKEN;
if (!token) throw new Error('Configure SUPABASE_ACCESS_TOKEN for the transactional SQL test');
const ref = new URL(process.env.SUPABASE_URL).hostname.split('.')[0];
const migration = (await readFile('supabase/migrations/20261008040000_lists.sql', 'utf8'))
  .replace(/^begin;\s*/, '').replace(/commit;\s*$/, '');
const assertions = await readFile('tests/fixtures/lists.sql', 'utf8');
const installed = process.argv.includes('--installed');
const response = await fetch(`https://api.supabase.com/v1/projects/${ref}/database/query`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ query: `begin;\n${installed ? '' : migration}\n${assertions}\nrollback;` }),
  signal: AbortSignal.timeout(30000),
});
if (!response.ok) {
  // No response body is printed: database errors may include user data.
  throw new Error(`List SQL assertions failed (HTTP ${response.status})`);
}
console.log(`List SQL assertions passed; ${installed ? 'fixtures' : 'migration and fixtures'} rolled back.`);
