import type { PurchaseConnection } from '../lib/server/purchase-persistence.js';
import { recalculatePendingPurchases, type PurchaseRecalculationOutcome } from '../lib/server/purchase-recalculation.js';

type LocalConnection = PurchaseConnection & { close(): Promise<void> };

// Explicit opt-in for local review executors. No env, transport, timer or sender.
// connect must provide a fresh exclusive connection; pending work lives in SQL.
export function localPurchaseReviews(connect: () => Promise<LocalConnection>, limit = 25) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('invalid_purchase_batch');
  let active: Promise<PurchaseRecalculationOutcome[]> | undefined;
  let requested = false;
  async function drain() {
    const outcomes: PurchaseRecalculationOutcome[] = [];
    do {
      requested = false;
      const db = await connect();
      try {
        let cursor: string | null = null;
        do {
          const batch = await recalculatePendingPurchases(db, { limit, ...(cursor ? { afterListId: cursor } : {}) });
          outcomes.push(...batch.outcomes);
          cursor = batch.nextAfterListId;
        } while (cursor);
      } finally { await db.close(); }
      // A review finishing during this sweep may invalidate an earlier UUID.
      // Restart discovery, never retry a captured result or spin on deferrals.
    } while (requested);
    return outcomes;
  }
  function request() {
    requested = true;
    active ??= drain().finally(() => { active = undefined; });
    return active;
  }
  return { afterProductReview: request, recover: request };
}
