import { readFile } from 'node:fs/promises';
const token = process.env.SUPABASE_ACCESS_TOKEN;
if (!token) throw new Error('Configure SUPABASE_ACCESS_TOKEN for the transactional SQL test');
const ref = new URL(process.env.SUPABASE_URL).hostname.split('.')[0];
const migration = (await readFile('supabase/migrations/20261011000000_list_baskets.sql', 'utf8')).replace(/^begin;\s*/, '').replace(/commit;\s*$/, '');
const assertions = await readFile('tests/fixtures/baskets.sql', 'utf8');
const installed = process.argv.includes('--installed');
const response = await fetch(`https://api.supabase.com/v1/projects/${ref}/database/query`, {
  method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ query: `begin;\n${installed ? '' : migration}\n${assertions}\nrollback;` }), signal: AbortSignal.timeout(30000),
});
if (!response.ok) throw new Error(`Basket SQL assertions failed (HTTP ${response.status}); no changes committed`);
console.log('Basket totals, crossing claims, permissions and individual-state isolation passed; all changes rolled back.');
