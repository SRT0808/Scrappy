import { readFile, readdir, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { execFileSync, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve, join } from 'node:path';
import { createServer } from 'node:net';

// Isolated PostgreSQL on Windows; never reads .env or contacts Supabase.
const bin = process.env.POSTGRES_BIN ?? 'C:/Program Files/PostgreSQL/18/bin';
const executable = (name) => join(bin, name + (process.platform === 'win32' ? '.exe' : ''));
const root = resolve('.scrappy');
await mkdir(root, { recursive: true });
const dir = await mkdtemp(join(root, 'basket-alerts-pg-'));
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
  const migrationName = '20261011030000_basket_alerts_repair.sql';
  for (const name of (await readdir('supabase/migrations')).filter((name) => name.endsWith('.sql') && name < migrationName).sort()) {
    const file = resolve('supabase/migrations', name);
    run('psql', ['-X', '-v', 'ON_ERROR_STOP=1', '-h', '127.0.0.1', '-p', String(port), '-U', 'postgres', '-d', 'postgres', '-f', file]);
  }
  const migration = (await readFile(`supabase/migrations/${migrationName}`, 'utf8')).replace(/^begin;\s*/, '').replace(/commit;\s*$/, '');
  const [before, assertions] = (await readFile('tests/fixtures/basket-alerts.sql', 'utf8')).split('-- AFTER MIGRATION');
  if (!assertions) throw new Error('Missing migration boundary');
  const fixture = join(dir, 'assertions.sql');
  await writeFile(fixture, `begin;\n${before}\n${migration}\n grant select on original_products, original_checks, original_items, original_notifications, original_snapshots to service_role;\n${assertions}\nrollback;\n
    do $$ begin
      if exists(select 1 from information_schema.columns where table_name='basket_events' and column_name='cause')
        or exists (select 1 from public.products) or exists (select 1 from public.lists) then
        raise exception 'Transaction did not restore schema and fixture data';
      end if;
    end $$;`);
  run('psql', ['-X', '-v', 'ON_ERROR_STOP=1', '-h', '127.0.0.1', '-p', String(port), '-U', 'postgres', '-d', 'postgres', '-f', fixture]);
  run('psql', ['-X', '-v', 'ON_ERROR_STOP=1', '-h', '127.0.0.1', '-p', String(port), '-U', 'postgres', '-d', 'postgres',
    '-f', resolve('supabase/migrations', migrationName)]);
  sql(`insert into public.lists(id,name,budget,currency) values('10000000-0000-0000-0000-000000000001','Concurrent',100,'PEN');
    insert into public.products(id,url,domain,currency,reference_price,last_price,last_success_at,status)
      values('20000000-0000-0000-0000-000000000001','https://shop.pe/item','shop.pe','PEN',150,90,now(),'active');
    insert into public.basket_items(list_id,product_id) values('10000000-0000-0000-0000-000000000001','20000000-0000-0000-0000-000000000001');`);
  const concurrent = () => promisify(execFile)(executable('psql'), ['-X', '-v', 'ON_ERROR_STOP=1',
    '-h', '127.0.0.1', '-p', String(port), '-U', 'postgres', '-d', 'postgres', '-c',
    'begin; set local role service_role; select count(*) from public.claim_basket_events(); select pg_sleep(0.2); commit;'],
    { encoding: 'utf8', windowsHide: true, timeout: 10000 });
  await Promise.all([concurrent(), concurrent()]);
  sql(`do $$ begin if (select count(*) from public.basket_events) <> 1 then
    raise exception 'Concurrent claims duplicated event'; end if; end $$;`);
  console.log('Local PostgreSQL: aggregate hysteresis, retries, versions, FX cause, repair preservation, RLS and rollback passed.');
} catch (error) {
  throw new Error(error.stderr?.toString() || error.message);
} finally {
  if (started) run('pg_ctl', ['-D', data, '-m', 'immediate', '-w', 'stop']);
  // Only the uniquely created directory under .scrappy is removed.
  await rm(dir, { recursive: true, force: true });
}
