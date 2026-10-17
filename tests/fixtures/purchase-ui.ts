import { evaluatePurchases } from '../../lib/server/purchase-engine';
import type { Configuration, PurchaseRead } from '../../src/lib/purchases';
export const purchaseId = '11111111-1111-4111-8111-111111111111';
export const uid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
export function purchaseFixture(): PurchaseRead {
  const c: Configuration = { schema_version: 2, version: '9007199254740993', currency: 'PEN', budget: '6.00', budget_enabled: true, winner_enabled: true, minimum_savings: '1.00',
    needs: [{ id: uid(1), name: 'Agua', required_quantity: '1000', unit: 'ml', allow_surplus: false, position: 0 }, { id: uid(2), name: 'Galletas', required_quantity: '1', unit: 'unit', allow_surplus: false, position: 1 }],
    offers: [{ id: uid(3), product_id: uid(4), max_purchase_units: null, coverage: [{ need_id: uid(1), quantity: '1000' }, { need_id: uid(2), quantity: '1' }], extras: [] }, { id: uid(5), product_id: uid(6), max_purchase_units: 1, coverage: [{ need_id: uid(1), quantity: '1000' }, { need_id: uid(2), quantity: '1' }], extras: [] }],
    alternatives: [{ id: uid(7), name: 'Combo económico', position: 0, scope: [uid(1), uid(2)], items: [{ offer_id: uid(3), purchase_units: 1 }] }, { id: uid(8), name: 'Combo fijado', position: 1, scope: [uid(1), uid(2)], items: [{ offer_id: uid(5), purchase_units: 1 }] }], pins: [uid(8)], reference: [uid(8)] };
  const at = '2026-10-16T18:00:00Z';
  const result = evaluatePurchases({ configurationVersion: c.version!, currency: c.currency, evaluatedAt: at,
    needs: c.needs.map(n => ({ id: n.id, quantity: n.required_quantity, unit: n.unit })),
    offers: c.offers.map((o, i) => ({ id: o.id, productId: o.product_id, currency: 'PEN', price: i ? '5.01' : '5.00', confirmed: true, available: true, pendingFailure: false, suspicious: false, priceCheckId: uid(10 + i), lastSuccessAt: at, coverage: o.coverage.map(x => ({ needId: x.need_id, quantity: x.quantity, unit: c.needs.find(n => n.id === x.need_id)!.unit })) })),
    alternatives: c.alternatives.map(a => ({ id: a.id, scope: a.scope, items: a.items.map(x => ({ offerId: x.offer_id, purchaseUnits: String(x.purchase_units) })) })), pins: c.pins, reference: c.reference });
  return { schema_version: 2, list_id: purchaseId, version: c.version!, mode: 'alternatives', configuration: c, stale_reason: null,
    latest_evaluation: { evaluation_id: uid(12), snapshot: { configuration_version: c.version!, currency: c.currency, evaluated_at: at, result } },
    events: [{ id: uid(13), version: c.version!, reasons: 'both', status: 'claimed', deliveries: [{ channel: 'ntfy', status: 'sent', receipt: { status: 'sent' } }, { channel: 'email', status: 'ambiguous', receipt: { status: 'ambiguous' } }] }], has_more: false };
}
