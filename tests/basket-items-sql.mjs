import { readFile, readdir, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { resolve, join } from 'node:path';
import { createServer } from 'node:net';

// Isolated PostgreSQL on Windows; never reads .env or contacts Supabase.
const bin = process.env.POSTGRES_BIN ?? 'C:/Program Files/PostgreSQL/18/bin';
const executable = (name) => join(bin, name + (process.platform === 'win32' ? '.exe' : ''));
const root = resolve('.scrappy');
await mkdir(root, { recursive: true });
const dir = await mkdtemp(join(root, 'basket-items-pg-'));
const data = join(dir, 'data');
const run = (name, args) => execFileSync(executable(name), args, {
  encoding: 'utf8', windowsHide: true, stdio: name === 'pg_ctl' ? 'ignore' : 'pipe', timeout: 60000,
});
const listener = createServer();
await new Promise((accept, reject) => { listener.once('error', reject); listener.listen(0, '127.0.0.1', accept); });
const port = listener.address().port;
await new Promise((accept) => listener.close(accept));
let started = false;
try {
  run('initdb', ['-D', data, '-U', 'postgres', '--auth=trust', '--encoding=UTF8', '--no-locale']);
  run('pg_ctl', ['-D', data, '-l', join(dir, 'postgres.log'), '-o', `-h 127.0.0.1 -p ${port}`, '-w', 'start']);
  started = true;
  const sql = (query) => run('psql', ['-X', '-v', 'ON_ERROR_STOP=1', '-h', '127.0.0.1', '-p', String(port), '-U', 'postgres', '-d', 'postgres', '-c', query]);
  sql('create role anon; create role authenticated; create role service_role bypassrls;');
  const migrationName = '20261011010000_basket_items.sql';
  for (const name of (await readdir('supabase/migrations')).filter((name) => name.endsWith('.sql') && name < migrationName).sort()) {
    const file = resolve('supabase/migrations', name);
    run('psql', ['-X', '-v', 'ON_ERROR_STOP=1', '-h', '127.0.0.1', '-p', String(port), '-U', 'postgres', '-d', 'postgres', '-f', file]);
  }
  const migration = (await readFile(`supabase/migrations/${migrationName}`, 'utf8')).replace(/^begin;\s*/, '').replace(/commit;\s*$/, '');
  const [before, after] = (await readFile('tests/fixtures/basket-items.sql', 'utf8')).split('-- AFTER MIGRATION');
  if (!after) throw new Error('Missing migration boundary');
  const fixture = join(dir, 'assertions.sql');
  await writeFile(fixture, `begin;\n${before}\n${migration}\n${after}\nrollback;\n
    do $$ begin
      if to_regclass('public.basket_items') is not null
        or not exists (select 1 from information_schema.columns where table_schema='public' and table_name='products' and column_name='list_id')
        or exists (select 1 from public.products) or exists (select 1 from public.lists) then
        raise exception 'Transaction did not restore schema and fixture data';
      end if;
    end $$;`);
  run('psql', ['-X', '-v', 'ON_ERROR_STOP=1', '-h', '127.0.0.1', '-p', String(port), '-U', 'postgres', '-d', 'postgres', '-f', fixture]);
  console.log('Local PostgreSQL: migration preservation, optional/multiple memberships, constraints, RPCs, permissions and rollback passed.');
} catch (error) {
  throw new Error(error.stderr?.toString() || error.message);
} finally {
  if (started) run('pg_ctl', ['-D', data, '-m', 'immediate', '-w', 'stop']);
  // Only the uniquely created directory under .scrappy is removed.
  await rm(dir, { recursive: true, force: true });
}
