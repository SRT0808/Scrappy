import type { PurchaseConnection } from './purchase-persistence.js';
import { recalculatePendingPurchases, type PurchaseRecalculationOutcome } from './purchase-recalculation.js';
import { deliverPurchaseNoticeLocally, type PurchaseSenders } from './purchase-notices.js';

export interface PendingPurchaseEvent {
  eventId: string; listId: string; configurationVersion: string; evaluatedAt: string;
}
type DeliveryOutcomes = Awaited<ReturnType<typeof deliverPurchaseNoticeLocally>>;
export interface PurchaseWorkerReport {
  recalculations: PurchaseRecalculationOutcome[];
  deliveries: { event: PendingPurchaseEvent; outcomes: DeliveryOutcomes }[];
  remaining: { recalculations: boolean; deliveries: boolean };
  deadlineReached: boolean;
}
export class PurchaseWorkerError extends Error {
  constructor(public readonly report: PurchaseWorkerReport, public readonly failures: unknown[]) {
    super('purchase_worker_failed');
  }
}
export type PurchaseWorkerSenders = Record<keyof PurchaseSenders,
  (notice: Parameters<PurchaseSenders['ntfy']>[0],
   context: Parameters<PurchaseSenders['ntfy']>[1] & PendingPurchaseEvent) => ReturnType<PurchaseSenders['ntfy']>>;
export interface PurchaseWorkerConnectionBudget {
  connectTimeoutMs: number;
  queryTimeoutMs: number;
  remainingMs: () => number;
}

// Opt-in orchestration only. No environment, driver, scheduler or default hook.
// connect supplies a fresh exclusive session with bounded connection/query times.
// The deadline is cooperative between SQL items; in-flight transactions finish.
export function purchaseWorker(options: {
  connect: (budget: PurchaseWorkerConnectionBudget) => Promise<PurchaseConnection & { close(): Promise<void> }>;
  channels: PurchaseWorkerSenders;
  now: () => number;
}) {
  let active: Promise<PurchaseWorkerReport> | undefined;
  let requested = false;
  async function run() {
    const deadline = options.now() + 180000;
    const beforeDeadline = () => options.now() < deadline;
    // Reserve 15s for transport, six queries at <=2s for claim/finish, plus
    // margin. The injected adapter must honor these budgets, including close.
    const canClaim = () => options.now() + 30000 <= deadline;
    const report: PurchaseWorkerReport = { recalculations: [], deliveries: [],
      remaining: { recalculations: false, deliveries: false }, deadlineReached: false };
    const failures: unknown[] = [];
    async function sweep(work: (db: PurchaseConnection) => Promise<void>) {
      const db = await options.connect({ connectTimeoutMs: Math.min(5000, deadline - options.now()),
        queryTimeoutMs: 2000, remainingMs: () => Math.max(0, deadline - options.now()) });
      try { await work(db); } finally { await db.close(); }
    }
    do {
      requested = false;
      if (!beforeDeadline()) { report.remaining.recalculations = report.remaining.deliveries = true; break; }
      try {
        await sweep(async db => {
          let cursor: string | null = null;
          do {
            if (!beforeDeadline()) { report.remaining.recalculations = true; break; }
            const batch = await recalculatePendingPurchases(db, { limit: 25,
              ...(cursor ? { afterListId: cursor } : {}), shouldContinue: beforeDeadline });
            report.recalculations.push(...batch.outcomes);
            if (batch.stopped || batch.outcomes.some(o => o.disposition === 'deferred')) report.remaining.recalculations = true;
            for (const outcome of batch.outcomes) if (outcome.status === 503) failures.push(outcome);
            cursor = batch.nextAfterListId;
          } while (cursor);
        });
      } catch (error) { failures.push(error); report.remaining.recalculations = true; }

      // Always discover durable channel work independently, even after a
      // recalculation outage or a commit whose acknowledgement was lost.
      if (!beforeDeadline()) { report.remaining.deliveries = true; break; }
      try {
        await sweep(async db => {
          let cursor: PendingPurchaseEvent | null = null;
          for (;;) {
            if (!beforeDeadline()) { report.remaining.deliveries = true; break; }
            const rows = (await db.query(`SELECT jsonb_build_object(
              'eventId',e.id,'listId',e.list_id,'configurationVersion',e.version::text,
              'evaluatedAt',v.evaluated_at::text) AS value
              FROM public.purchase_events e JOIN public.purchase_evaluations v ON v.id=e.evaluation_id
              WHERE EXISTS (SELECT 1 FROM public.purchase_deliveries d WHERE d.event_id=e.id AND d.status='pending')
              AND ($1::timestamptz IS NULL OR (v.evaluated_at,e.id)>($1::timestamptz,$2::uuid))
              ORDER BY v.evaluated_at,e.id LIMIT 25`, [cursor?.evaluatedAt ?? null, cursor?.eventId ?? null])).rows;
            for (const row of rows) {
              if (!beforeDeadline()) { report.remaining.deliveries = true; return; }
              const event = row.value as unknown as PendingPurchaseEvent;
              const outcomes = await deliverPurchaseNoticeLocally(db, event.eventId, {
                ntfy: (notice, context) => options.channels.ntfy(notice, { ...context, ...event }),
                email: (notice, context) => options.channels.email(notice, { ...context, ...event }),
              }, { canClaim, timeoutMs: 15000 });
              report.deliveries.push({ event, outcomes });
              if (Object.values(outcomes).includes('deferred')) { report.remaining.deliveries = true; return; }
              if (Object.values(outcomes).includes('unrecorded')) {
                failures.push(new Error('purchase_receipt_unrecorded')); report.remaining.deliveries = true;
              }
              cursor = event;
            }
            if (rows.length < 25) break;
          }
        });
      } catch (error) { failures.push(error); report.remaining.deliveries = true; }
      // An overlapping callback requests a fresh sweep, under the ORIGINAL
      // deadline. No captured inputs or claimed sends are replayed from RAM.
    } while (requested && beforeDeadline() && failures.length === 0);
    if (requested) report.remaining.recalculations = report.remaining.deliveries = true;
    report.deadlineReached = !beforeDeadline();
    if (failures.length) throw new PurchaseWorkerError(report, failures);
    return report;
  }
  function request() {
    requested = true;
    active ??= run().finally(() => { active = undefined; });
    return active;
  }
  return { afterProductReview: request, recover: request };
}
