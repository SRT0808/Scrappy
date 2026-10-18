import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { purchasePostgres } from '../lib/server/purchase-postgres.js';
import { purchaseTransports } from '../lib/server/purchase-transports.js';
import { purchaseWorker } from '../lib/server/purchase-worker.js';

// No environment reads, connections or sends at import time.
interface PurchaseActionsDependencies {
  database: (options: Parameters<typeof purchasePostgres>[0]) => Parameters<typeof purchaseWorker>[0]['connect'];
  transports: typeof purchaseTransports;
  worker: typeof purchaseWorker;
}
export async function runPurchaseActions(env: NodeJS.ProcessEnv, dependencies: PurchaseActionsDependencies = {
  database: purchasePostgres, transports: purchaseTransports, worker: purchaseWorker,
}) {
  if (env.PURCHASE_WORKER_ENABLED !== 'true' || !['all', 'product'].includes(env.RUN_MODE ?? ''))
    return { skipped: true };
  const required = (name: string) => {
    const value = env[name];
    if (!value) throw new Error('missing_purchase_runtime_configuration');
    return value;
  };
  const databaseUrl = required('PURCHASE_DATABASE_URL');
  const channels = dependencies.transports({ appOrigin: required('PURCHASE_APP_ORIGIN'),
    ntfyTopic: required('NTFY_TOPIC'), gmailUser: required('GMAIL_USER'),
    gmailPassword: required('GMAIL_APP_PASSWORD'), emailTo: required('NOTIFY_EMAIL_TO') });
  const connect = dependencies.database({ databaseUrl, ca: env.PURCHASE_DATABASE_CA || undefined });
  // Recovery discovers persisted work even when Python reviewed zero products.
  const report = await dependencies.worker({ connect, channels, now: () => performance.now() }).recover();
  return { skipped: false, recalculations: report.recalculations.length,
    conflicts: report.recalculations.filter(item => item.disposition === 'deferred').length,
    deliveries: report.deliveries.length, remaining: report.remaining, deadlineReached: report.deadlineReached };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { console.log('Alternativas:', JSON.stringify(await runPurchaseActions(process.env))); }
  catch {
    // Driver/provider errors may contain credentials. Never print raw errors.
    console.error('Falló el worker de alternativas; revisa configuración y recibos antes de recuperar.');
    process.exitCode = 1;
  }
}
