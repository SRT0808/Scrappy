import {
  capturePendingPurchaseInputs, commitPurchaseEvaluation, evaluatePurchaseCapture,
  purchaseErrorStatus, type PurchaseConnection,
} from './purchase-persistence.js';

export interface PurchaseRecalculationOutcome {
  listId: string;
  disposition: 'committed' | 'skipped' | 'deferred';
  status?: number;
}
const uuid = /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;

// Explicit local invocation only: no route, scheduler, scraping or channel delivery.
// The caller owns an exclusive connection for the entire bounded pass. Durable
// pending work is the existing runtime/current validity predicate, never RAM.
export async function recalculatePendingPurchases(
  db: PurchaseConnection, options: { limit?: number; afterListId?: string; shouldContinue?: () => boolean } = {},
) {
  const limit = options.limit ?? 25;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100 ||
      (options.afterListId !== undefined && !uuid.test(options.afterListId))) throw new Error('invalid_purchase_batch');
  // Discovery is advisory and takes no source locks. Recheck inside capture.
  const candidates = (await db.query(`SELECT jsonb_build_object('list_id',l.id) AS value
    FROM public.lists l WHERE l.purchase_mode='alternatives'
    AND ($1::uuid IS NULL OR l.id>$1::uuid)
    AND public.read_current_purchase_evaluation(l.id)->>'evaluation_id' IS NULL
    ORDER BY l.id LIMIT $2::integer`, [options.afterListId ?? null, limit])).rows;
  const outcomes: PurchaseRecalculationOutcome[] = [];
  for (const row of candidates) {
    if (options.shouldContinue && !options.shouldContinue()) {
      return { outcomes, nextAfterListId: null, stopped: true };
    }
    const listId = (row.value as { list_id: string }).list_id;
    try {
      const captured = await capturePendingPurchaseInputs(db, listId);
      if (!captured) { outcomes.push({ listId, disposition: 'skipped' }); continue; }
      const payload = evaluatePurchaseCapture(captured);
      await commitPurchaseEvaluation(db, listId, payload.capture.configuration_version, payload.capture.capture_signature, payload);
      outcomes.push({ listId, disposition: 'committed' });
    } catch (error) {
      // No result retry, acknowledgement or clearing on conflict/lost response.
      // The next explicit pass rediscovers authoritative state, including commits
      // that succeeded before a response was lost. Other baskets can progress.
      outcomes.push({ listId, disposition: 'deferred', status: purchaseErrorStatus(error) });
    }
  }
  return { outcomes, nextAfterListId: candidates.length === limit
    ? (candidates.at(-1)!.value as { list_id: string }).list_id : null };
}
