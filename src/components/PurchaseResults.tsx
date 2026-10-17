import { type Configuration, type PurchaseRead, type PurchaseResult } from '../lib/purchases';
import type { ProductSummary } from '../lib/products';

const reasons: Record<string, string> = { unsupported_currency: 'Moneda no soportada', unconfirmed: 'Sin confirmar', unavailable: 'Agotado', pending_failure: 'Última revisión fallida', suspicious: 'Precio sospechoso', missing_price: 'Sin precio válido', future_price: 'Fecha de precio futura', missing_fx: 'Falta conversión', invalid_fx: 'Conversión caducada o no válida', unaccepted_extra: 'Extra sin aceptar' };
export const purchaseMoney = (value: string | null, currency: string) => value === null ? 'Sin importe confirmado' : `${currency === 'PEN' ? 'S/' : currency} ${value}`;
export function PurchaseResults({ data, compact = false, products = [] }: { data: PurchaseRead; compact?: boolean; products?: ProductSummary[] }) {
  const c = data.configuration;
  const snapshot = !data.stale_reason ? data.latest_evaluation?.snapshot : null;
  const r = snapshot?.result;
  if (!c) return null;
  if (!r) return <p role="status" className="my-4 text-sm text-muted-foreground">Sin resultado vigente. Recálculo pendiente; no hay total ni meta confirmados.</p>;
  const money = (v: string | null) => purchaseMoney(v, c.currency);
  return <section aria-label="Resultado de alternativas" className="my-4 space-y-4 [overflow-wrap:anywhere]">
    <div className="rounded-xl border border-primary/40 bg-card p-4">
      <h2 className="font-medium">{!r.recommendation.searchComplete ? 'Mejor compra encontrada · optimalidad no demostrada' : r.recommendation.coverageComplete ? 'Más barata entre las opciones verificadas' : 'Recomendación con cobertura pendiente'}</h2>
      <p className="mt-2 text-xl font-semibold">{money(r.recommendation.total ?? r.recommendation.knownSubtotal)}</p>
      {!r.recommendation.coverageComplete && <p>Subtotal conocido; compra incompleta.</p>}
      <p className="mt-2 text-sm">Ahorro frente a referencia: {money(r.recommendationSavings.amount)}{r.recommendationSavings.percent !== null && ` (${r.recommendationSavings.percent} %)`}</p>
      {!r.recommendation.comparisonComplete && <p className="mt-2 text-sm text-muted-foreground">Comparación parcial: hay opciones excluidas.</p>}
      <p className="mt-2 text-sm">Selección efectiva{c.pins.length ? ' · con fijaciones' : ''}: {money(r.effective.total ?? r.effective.knownSubtotal)}{!r.effective.coverageComplete && ' · subtotal conocido'}</p>
      {r.effective.invalidPin && <p className="mt-2 text-sm text-destructive">Fijación inválida conservada. Cambia la fijación para completar la compra.</p>}
      {(!r.effective.coverageComplete || !r.effective.comparisonComplete || !r.effective.searchComplete || r.effective.invalidPin) && <p className="mt-2 text-sm text-muted-foreground">Meta agregada suspendida.</p>}
    </div>
    {!compact && <>
      <p className="text-xs text-muted-foreground">Evaluación: {new Date(snapshot!.evaluated_at).toLocaleString('es-PE')} · versión {data.version}</p>
      <Selection title="Compras efectivas · un cargo por oferta" selection={r.effective} c={c} products={products} />
      <details className="rounded-xl border border-border p-4"><summary className="cursor-pointer py-2">Desglose de la recomendación</summary><Selection title="Recomendación sin fijaciones" selection={r.recommendation} c={c} products={products} /></details>
      <h3 className="font-medium">Necesidades</h3>
      <ol className="space-y-3">{r.effective.coverage.map(n => <li key={n.needId} className="rounded-xl border border-border p-3"><strong>{c.needs.find(x => x.id === n.needId)?.name ?? n.needId}</strong><p className="mt-1 text-sm">Requerido: {n.required} {n.unit} · cubierto: {n.covered} · sobrante: {n.surplus}</p>{r.effective.pendingNeedIds.includes(n.needId) && <p className="text-sm text-destructive">Pendiente de cubrir</p>}</li>)}</ol>
      {r.exclusions.length > 0 && <div><h3 className="font-medium">Opciones excluidas</h3><ul className="mt-2 space-y-2 text-sm">{r.exclusions.map((x, i) => <li key={i}>{c.alternatives.find(a => a.id === x.alternativeId)?.name ?? x.alternativeId}: {reasons[x.reason] ?? 'Opción no válida'}{x.offerId && ` · oferta ${x.offerId}`}</li>)}</ul></div>}
    </>}
    <p className="text-xs text-muted-foreground">Excluye envío, cupones, membresías y condiciones de pago. Las repeticiones no garantizan stock suficiente.</p>
  </section>;
}
function Selection({ title, selection: s, c, products }: { title: string; selection: PurchaseResult['effective']; c: Configuration; products: ProductSummary[] }) {
  return <section className="space-y-3"><h3 className="font-medium">{title}</h3>{!s.searchComplete && <p className="text-sm">Cálculo limitado; optimalidad no demostrada.</p>}<ul className="space-y-3">{s.purchases.map(p => {
    const product = products.find(x => x.id === p.offer.productId);
    return <li key={p.offerId} className="rounded-xl border border-border p-3 text-sm">
    <p className="font-medium">{p.purchaseUnits} × {product?.name || `producto ${p.offer.productId}`} · {purchaseMoney(p.convertedAmount, c.currency)}</p>
    {product && <a className="inline-block py-3 text-primary underline" href={product.url} target="_blank" rel="noopener noreferrer">{product.domain} ↗</a>}
    <p className="mt-2">Cubre: {p.offer.coverage.map(n => `${c.needs.find(x => x.id === n.needId)?.name ?? n.needId}: ${n.quantity} ${n.unit} por compra`).join(' · ')}</p>
    <p className="mt-2 text-xs text-muted-foreground">Precio: {purchaseMoney(p.offer.price, p.offer.currency)} · lectura {p.offer.priceCheckId} · {p.offer.lastSuccessAt ? new Date(p.offer.lastSuccessAt).toLocaleString('es-PE') : 'Sin lectura'}</p>
    {p.offer.coverage.length === 1 && <p className="mt-1 text-xs">Precio normalizado informativo: {Number(p.offer.price) / Number(p.offer.coverage[0].quantity)} {p.offer.currency}/{p.offer.coverage[0].unit}</p>}
    {p.extras.map(x => <p key={x.id} className="mt-1">Extra {c.offers.find(o => o.id === p.offerId)?.extras.find(e => e.id === x.id)?.name}: {x.quantity} {x.unit} · {x.accepted ? 'aceptado' : 'sin aceptar'}</p>)}
  </li>; })}</ul></section>;
}
