import type { PurchaseConnection } from './purchase-persistence.js';

export interface PurchaseNotice {
  reasons: 'budget' | 'winner' | 'both'; currency: string; effective_total: string | null;
  savings: string | null; basket_path: string; offer_urls: { offer_id: string; url: string }[];
}
type Channel = 'ntfy' | 'email';
type DeliveryStatus = 'sent' | 'failed' | 'ambiguous';
async function transaction<T>(db: PurchaseConnection, work: () => Promise<T>) {
  await db.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
  try { const value = await work(); await db.query('COMMIT'); return value; }
  catch (error) { try { await db.query('ROLLBACK'); } catch { /* disconnected */ } throw error; }
}
export function purchaseNoticeMessage(payload: PurchaseNotice) {
  const reasons = [payload.reasons !== 'winner' ? `Presupuesto alcanzado: ${payload.effective_total} ${payload.currency}.` : '',
    payload.reasons !== 'budget' ? `Nueva combinación ganadora: ahorro de ${payload.savings} ${payload.currency} a precios actuales.` : ''].filter(Boolean);
  return { title: 'Aviso de alternativas de Scrappy', message: reasons.join(' '),
    basketPath: payload.basket_path, offers: payload.offer_urls };
}
// Explicit local harness only. No default transports, env, endpoints or scheduler.
// A sender must report definite rejection as failed; any throw is ambiguous.
export async function deliverPurchaseNoticeLocally(db: PurchaseConnection, eventId: string,
  channels: Record<Channel, (notice: ReturnType<typeof purchaseNoticeMessage>) => Promise<DeliveryStatus>>) {
  const outcomes: Partial<Record<Channel, DeliveryStatus | 'unclaimed' | 'unrecorded'>> = {};
  for (const channel of ['ntfy', 'email'] as const) {
    let payload: PurchaseNotice | null;
    try {
      payload = await transaction(db, async () => (await db.query(
        'SELECT public.claim_purchase_delivery($1::uuid,$2::text) AS value', [eventId, channel])).rows[0].value as PurchaseNotice | null);
    } catch { outcomes[channel] = 'unrecorded'; continue; } // uncertain claim: never send
    if (!payload) { outcomes[channel] = 'unclaimed'; continue; }
    let status: DeliveryStatus;
    try { status = await channels[channel](purchaseNoticeMessage(payload));
      if (!['sent', 'failed', 'ambiguous'].includes(status)) status = 'ambiguous';
    } catch { status = 'ambiguous'; }
    try {
      await transaction(db, () => db.query('SELECT public.finish_purchase_delivery($1::uuid,$2::text,$3::text)', [eventId, channel, status]));
      outcomes[channel] = status;
    } catch { outcomes[channel] = 'unrecorded'; } // durable claim blocks replay
  }
  return outcomes;
}
