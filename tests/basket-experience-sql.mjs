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
const dir = await mkdtemp(join(root, 'basket-experience-pg-'));
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
  for (const name of (await readdir('supabase/migrations')).filter(name => name.endsWith('.sql')).sort()) {
    run('psql', ['-X','-v','ON_ERROR_STOP=1','-h','127.0.0.1','-p',String(port),'-U','postgres','-d','postgres','-f',resolve('supabase/migrations',name)]);
  }
  run('psql',['-X','-v','ON_ERROR_STOP=1','-h','127.0.0.1','-p',String(port),'-U','postgres','-d','postgres','-f',resolve('tests/fixtures/basket-experience.sql')]);
  console.log('Local PostgreSQL: membership edits, stale versions, segmented history, permissions and product preservation passed.');
} catch (error) {
  throw new Error(error.stderr?.toString() || error.message);
} finally {
  if (started) run('pg_ctl', ['-D', data, '-m', 'immediate', '-w', 'stop']);
  // Only the uniquely created directory under .scrappy is removed.
  await rm(dir, { recursive: true, force: true });
}
