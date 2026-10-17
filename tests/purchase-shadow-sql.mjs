import { readFile, readdir, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { resolve, join } from 'node:path';
import { createServer } from 'node:net';

// Isolated PostgreSQL on Windows; never reads .env or contacts Supabase.
const bin = process.env.POSTGRES_BIN ?? 'C:/Program Files/PostgreSQL/18/bin';
const executable = (name) => join(bin, name + (process.platform === 'win32' ? '.exe' : ''));
const root = resolve('.scrappy');
await mkdir(root, { recursive: true });
const dir = await mkdtemp(join(root, 'purchase-shadow-pg-'));
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
  const migrationName = '20261016000000_purchase_shadow.sql';
  for (const name of (await readdir('supabase/migrations')).filter((name) => name.endsWith('.sql') && name < migrationName).sort()) {
    const file = resolve('supabase/migrations', name);
    run('psql', ['-X', '-v', 'ON_ERROR_STOP=1', '-h', '127.0.0.1', '-p', String(port), '-U', 'postgres', '-d', 'postgres', '-f', file]);
  }
  const migration = await readFile(`supabase/migrations/${migrationName}`, 'utf8');
  const down = await readFile('supabase/rollback/20261016000000_purchase_shadow.sql', 'utf8');
  const execute = async (name, content) => {
    const file = join(dir, name);
    await writeFile(file, content);
    return run('psql', ['-X','-v','ON_ERROR_STOP=1','-h','127.0.0.1','-p',String(port),'-U','postgres','-d','postgres','-f',file]);
  };
  await execute('fixture.sql', await readFile('tests/fixtures/purchase-shadow.sql','utf8'));
  // Inject failure after all DDL/backfill; disconnected transaction must undo everything.
  let failed = false;
  try { await execute('failed.sql', migration.replace(/commit;\s*$/, "select 1/0; commit;")); }
  catch (error) {
    if (!error.stderr?.toString().includes('division by zero')) throw error;
    failed = true;
  }
  if (!failed) throw new Error('Injected migration failure was not observed');
  sql("do $$ begin if to_regclass('public.purchase_configurations') is not null or exists(select 1 from information_schema.columns where table_name='lists' and column_name='purchase_mode') then raise exception 'Partial failed migration'; end if; end $$;");
  await execute('up.sql', migration);
  await execute('assertions.sql', await readFile('tests/fixtures/purchase-shadow-assertions.sql','utf8'));
  // Down must fail atomically once a list has been activated (local fixture only).
  sql("update public.lists set purchase_mode='alternatives' where id=md5('list1')::uuid;");
  let refused = false;
  try { await execute('refused-down.sql', down); }
  catch (error) {
    if (!error.stderr?.toString().includes('Cannot reverse activated purchase history')) throw error;
    refused = true;
  }
  if (!refused) throw new Error('Activated rollback was accepted');
  sql("do $$ begin if (select count(*) from pg_tables where schemaname='public' and tablename like 'purchase_%') <> 13 then raise exception 'Rejected down changed schema'; end if; end $$; update public.lists set purchase_mode='legacy' where id=md5('list1')::uuid;");
  await execute('down.sql', down);
  // Compare the same application objects as the snapshot, never fixture helpers.
  const grantsChanged = `exists(
    (select table_name,grantee,privilege_type from information_schema.table_privileges
      where table_schema='public' and left(table_name,7) <> 'shadow_' except select * from shadow_grants)
    union all (select * from shadow_grants except select table_name,grantee,privilege_type
      from information_schema.table_privileges where table_schema='public' and left(table_name,7) <> 'shadow_'))`;
  const checkGrants = `do $$ begin if ${grantsChanged} then raise exception 'Grants changed'; end if; end $$;`;
  // Compare full legacy rows, definitions and grants after committed up/down.
  sql(`do $$ declare r record; actual jsonb; begin
    for r in select * from shadow_original loop
      execute format('select coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text), ''[]''::jsonb) from public.%I t',r.name) into actual;
      if actual is distinct from r.rows then raise exception 'Rollback changed %',r.name; end if;
    end loop;
    if exists(select 1 from pg_tables where schemaname='public' and tablename like 'purchase_%') then raise exception 'Additive tables remain'; end if;
    -- Windows checkouts can use CRLF in down SQL and LF in older migrations.
    if replace(pg_get_functiondef('public.read_lists_with_baskets()'::regprocedure), chr(13)||chr(10), chr(10))
      is distinct from (select replace(definition, chr(13)||chr(10), chr(10)) from shadow_function) then raise exception 'Function not restored'; end if;
    if ${grantsChanged} then raise exception 'Grants changed'; end if;
  end $$;`);
  // Each rejected transaction disconnects without committing its permission change.
  for (const change of ['grant select on public.lists to anon;', 'revoke select on public.lists from service_role;']) {
    let detected = false;
    try { sql(`begin; ${change} ${checkGrants}`); }
    catch (error) {
      if (!error.stderr?.toString().includes('Grants changed')) throw error;
      detected = true;
    }
    if (!detected) throw new Error(`Grant comparator missed: ${change}`);
  }
  sql(checkGrants);
  console.log('Local PostgreSQL: preservation, max-int/empty/FX fixtures, shadow-only grants/RLS, cross-list/version FKs, product restriction, cascade, failed transaction, committed up/down and added/removed grant detection passed.');
} catch (error) {
  throw new Error(error.stderr?.toString() || error.message);
} finally {
  if (started) run('pg_ctl', ['-D', data, '-m', 'immediate', '-w', 'stop']);
  if (!dir.startsWith(root + (process.platform === 'win32' ? '\\' : '/')) || !dir.split(/[\\/]/).at(-1).startsWith('purchase-shadow-pg-')) {
    throw new Error('Refusing cleanup outside the temporary fixture directory');
  }
  await rm(dir, { recursive: true, force: true });
}
