import pg, { type ClientConfig } from 'pg';
import { Socket } from 'node:net';
import type { PurchaseWorkerConnectionBudget } from './purchase-worker.js';

type Session = Pick<pg.Client, 'connect' | 'query' | 'end' | 'on'>;
export interface PurchaseDatabaseOptions {
  databaseUrl: string;
  ca?: string;
  localFixture?: boolean;
}

// Reject URL options so sslmode/options cannot override verified TLS or timeouts.
export function purchaseDatabaseConfig(options: PurchaseDatabaseOptions, budget: PurchaseWorkerConnectionBudget): ClientConfig {
  const url = new URL(options.databaseUrl);
  const user = decodeURIComponent(url.username), password = decodeURIComponent(url.password);
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.hostname || !user || !password ||
      !url.pathname.slice(1) || url.search || url.hash ||
      ['postgres', 'service_role', 'supabase_admin'].includes(user) ||
      (options.localFixture && !['127.0.0.1', '[::1]'].includes(url.hostname))) throw new Error('invalid_purchase_database_config');
  const connectMs = Math.floor(Math.min(5000, budget.connectTimeoutMs, budget.remainingMs()));
  const queryMs = Math.floor(Math.min(2000, budget.queryTimeoutMs, budget.remainingMs()));
  if (!(connectMs > 0 && queryMs > 0)) throw new Error('purchase_database_deadline');
  return { host: url.hostname.replace(/^\[|\]$/g, ''), port: Number(url.port || 5432), user, password,
    // pg falls back to PGOPTIONS for an empty string, so use an explicit option.
    database: decodeURIComponent(url.pathname.slice(1)), options: '-c search_path=pg_catalog,public',
    application_name: 'scrappy-purchase-worker', sslnegotiation: 'postgres',
    ssl: options.localFixture ? false : { rejectUnauthorized: true, ...(options.ca ? { ca: options.ca } : {}) },
    connectionTimeoutMillis: connectMs, query_timeout: queryMs, statement_timeout: queryMs,
    lock_timeout: queryMs, idle_in_transaction_session_timeout: 5000 };
}

// A dedicated NOINHERIT login may assume only service_role, owns no objects and
// has no elevated cluster attributes. Provisioning/grants are a deployment step.
const loginCheck = `SELECT NOT (r.rolsuper OR r.rolcreatedb OR r.rolcreaterole OR r.rolreplication OR r.rolbypassrls OR r.rolinherit)
  AND r.rolcanlogin AND pg_has_role(session_user,'service_role','MEMBER')
  AND NOT EXISTS (SELECT 1 FROM pg_auth_members m JOIN pg_roles g ON g.oid=m.roleid
    WHERE m.member=r.oid AND (g.rolname<>'service_role' OR m.admin_option OR m.inherit_option OR NOT m.set_option))
  AND NOT EXISTS (SELECT 1 FROM pg_shdepend d WHERE d.refclassid='pg_authid'::regclass AND d.refobjid=r.oid AND d.deptype='o') AS allowed
  FROM pg_roles r WHERE r.rolname=session_user`;

export function purchasePostgres(options: PurchaseDatabaseOptions,
  createClient?: (config: ClientConfig) => Session) {
  return async (budget: PurchaseWorkerConnectionBudget) => {
    const config = purchaseDatabaseConfig(options, budget);
    const socket = createClient ? undefined : new Socket();
    const client = createClient ? createClient(config) : new pg.Client({ ...config, stream: () => socket! });
    let closed = false, broken = false, busy = false;
    let closing: Promise<void> | undefined;
    client.on('error', () => { broken = true; }); // idle socket errors must not crash the executor
    function close() {
      return closing ??= (async () => {
        closed = true;
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([client.end(), new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error('purchase_database_close_timeout')), Math.min(2000, budget.queryTimeoutMs));
          })]);
        } finally { clearTimeout(timer); socket?.destroy(); }
      })();
    }
    async function query(sql: string, parameters: unknown[] = []) {
      if (closed || broken || busy) throw new Error('purchase_database_unavailable');
      const ms = Math.floor(Math.min(2000, budget.queryTimeoutMs, budget.remainingMs()));
      if (ms <= 0) throw new Error('purchase_database_deadline');
      busy = true;
      const config = { text: sql, values: parameters, query_timeout: ms };
      try { return await client.query(config); }
      catch (error) {
        // A client timeout can leave SQL executing. Disconnect instead of reusing
        // the session or replaying a transaction whose acknowledgement was lost.
        if (!(error as { code?: string }).code) { broken = true; await close(); }
        throw error;
      } finally { busy = false; }
    }
    try {
      await client.connect();
      if ((await query(loginCheck)).rows[0]?.allowed !== true) throw new Error('unsafe_purchase_database_role');
      await query('SET ROLE service_role');
      const role = (await query(`SELECT current_user='service_role' AND NOT (rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication) AS allowed
        FROM pg_roles WHERE rolname=current_user`)).rows[0];
      if (role?.allowed !== true) throw new Error('unsafe_purchase_service_role');
      return { query, close };
    } catch (error) { await close(); throw error; }
  };
}
