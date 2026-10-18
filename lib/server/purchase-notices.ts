import type { PurchaseConnection } from './purchase-persistence.js';

export interface PurchaseNotice {
  reasons: 'budget' | 'winner' | 'both'; currency: string; effective_total: string | null;
  savings: string | null; basket_path: string; offer_urls: { offer_id: string; url: string }[];
}
export type Channel = 'ntfy' | 'email';
export type DeliveryStatus = 'sent' | 'failed' | 'ambiguous';
export type PurchaseSenders = Record<Channel, (notice: ReturnType<typeof purchaseNoticeMessage>,
  context: { signal: AbortSignal; timeoutMs: number }) => Promise<DeliveryStatus>>;
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
  channels: PurchaseSenders, options: { canClaim?: () => boolean; timeoutMs?: number } = {}) {
  const timeoutMs = options.timeoutMs ?? 15000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 15000) throw new Error('invalid_purchase_timeout');
  const outcomes: Partial<Record<Channel, DeliveryStatus | 'unclaimed' | 'unrecorded' | 'deferred'>> = {};
  for (const channel of ['ntfy', 'email'] as const) {
    if (options.canClaim && !options.canClaim()) { outcomes[channel] = 'deferred'; continue; }
    let payload: PurchaseNotice | null;
    try {
      payload = await transaction(db, async () => (await db.query(
        'SELECT public.claim_purchase_delivery($1::uuid,$2::text) AS value', [eventId, channel])).rows[0].value as PurchaseNotice | null);
    } catch { outcomes[channel] = 'unrecorded'; continue; } // uncertain claim: never send
    if (!payload) { outcomes[channel] = 'unclaimed'; continue; }
    let status: DeliveryStatus;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { status = options.canClaim && !options.canClaim() ? 'ambiguous' : await Promise.race([
      Promise.resolve().then(() => channels[channel](purchaseNoticeMessage(payload!), { signal: controller.signal, timeoutMs })),
      new Promise<DeliveryStatus>(resolve => {
        timer = setTimeout(() => { controller.abort(); resolve('ambiguous'); }, timeoutMs);
      }),
    ]);
      if (!['sent', 'failed', 'ambiguous'].includes(status)) status = 'ambiguous';
    } catch { status = 'ambiguous'; }
    finally { clearTimeout(timer); }
    try {
      await transaction(db, () => db.query('SELECT public.finish_purchase_delivery($1::uuid,$2::text,$3::text)', [eventId, channel, status]));
      outcomes[channel] = status;
    } catch { outcomes[channel] = 'unrecorded'; } // durable claim blocks replay
  }
  return outcomes;
}
