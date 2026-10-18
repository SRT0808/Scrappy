import { type Configuration, type PurchaseRead, type PurchaseResult } from '../lib/purchases';
import type { ProductSummary } from '../lib/products';

const reasons: Record<string, string> = { unsupported_currency: 'Moneda no soportada', unconfirmed: 'Sin confirmar', unavailable: 'Agotado', pending_failure: 'Última revisión fallida', suspicious: 'Precio sospechoso', missing_price: 'Sin precio válido', future_price: 'Fecha de precio futura', missing_fx: 'Falta conversión', invalid_fx: 'Conversión caducada o no válida', unaccepted_extra: 'Extra sin aceptar' };
export const purchaseMoney = (value: string | null, currency: string) => value === null ? 'Sin importe confirmado' : `${currency === 'PEN' ? 'S/' : currency} ${value}`;
export function PurchaseResults({ data, compact = false, products = [] }: { data: PurchaseRead; compact?: boolean; products?: ProductSummary[] }) {
  const c = data.configuration;
  const snapshot = !data.stale_reason ? data.latest_evaluation?.snapshot : null;
  const r = snapshot?.result;
  if (!c) return null;
  if (!r) return <p role="status" className="my-4 text-sm text-muted-foreground">Sin resultado vigente. {data.stale_reason === 'uncertain' ? 'Actualiza el resultado para confirmarlo; consultar no repite el guardado.' : 'El cálculo se actualizará en la próxima revisión automática; todavía no hay total ni meta confirmados.'}</p>;
  const selectionKey = (selection: PurchaseResult['effective']) => JSON.stringify(selection.purchases.map(p => `${p.offerId}:${p.purchaseUnits}`).sort());
  const different = selectionKey(r.effective) !== selectionKey(r.recommendation);
  const money = (v: string | null) => purchaseMoney(v, c.currency);
  return <section aria-label="Resultado de alternativas" className="my-4 space-y-4 [overflow-wrap:anywhere]">
    <div className="rounded-xl border border-primary/40 bg-card p-4">
      <p className="mb-4 text-sm" hidden={!different}>Tu elección{c.pins.length ? ' · opciones elegidas por ti' : ''}: <strong className="mt-1 block text-3xl tabular-nums">{money(r.effective.total ?? r.effective.knownSubtotal)}</strong>{!r.effective.coverageComplete && ' · subtotal conocido'}</p>
      <h2 className="font-medium">{!r.recommendation.searchComplete ? 'Mejor compra encontrada · optimalidad no demostrada' : r.recommendation.coverageComplete ? 'Más barata entre las opciones verificadas' : 'Recomendación con cobertura pendiente'}</h2>
      <p className="mt-2 text-xl font-semibold">{money(r.recommendation.total ?? r.recommendation.knownSubtotal)}</p>
      {!r.recommendation.coverageComplete && <p>Subtotal conocido; compra incompleta.</p>}
      <p className="mt-2 text-sm">Ahorro frente a referencia: {money(r.recommendationSavings.amount)}{r.recommendationSavings.percent !== null && ` (${r.recommendationSavings.percent} %)`}</p>
      {!r.recommendation.comparisonComplete && <p className="mt-2 text-sm text-muted-foreground">Comparación parcial: hay opciones excluidas.</p>}
      {r.effective.invalidPin && <p className="mt-2 text-sm text-destructive">La opción que elegiste no puede completar la compra. Revisa tu elección; no la hemos sustituido.</p>}
      {(!r.effective.coverageComplete || !r.effective.comparisonComplete || !r.effective.searchComplete || r.effective.invalidPin) && <p className="mt-2 text-sm text-muted-foreground">Los avisos de presupuesto quedan suspendidos hasta completar la compra y su comparación.</p>}
    </div>
    {!compact && <>
      <p className="text-xs text-muted-foreground">Actualizado el {new Date(snapshot!.evaluated_at).toLocaleString('es-PE')}</p>
      <Selection title="Qué comprar · cada producto se cobra una vez" selection={r.effective} c={c} products={products} />
      <details hidden={!different} className="rounded-xl border border-border p-4"><summary className="cursor-pointer py-2">Desglose de la recomendación</summary><Selection title="Opción más barata sin tus preferencias" selection={r.recommendation} c={c} products={products} /></details>
      <h3 className="font-medium">Necesidades</h3>
      <ol className="space-y-3">{r.effective.coverage.map(n => <li key={n.needId} className="rounded-xl border border-border p-3"><strong>{c.needs.find(x => x.id === n.needId)?.name ?? n.needId}</strong><p className="mt-1 text-sm">Requerido: {quantity(n.required)} {unit(n.unit)} · cubierto: {quantity(n.covered)}{Number(n.surplus) > 0 && ` · sobrante: ${quantity(n.surplus)}`}</p>{r.effective.pendingNeedIds.includes(n.needId) && <p className="text-sm text-destructive">Pendiente de cubrir</p>}</li>)}</ol>
      {r.exclusions.length > 0 && <div><h3 className="font-medium">Opciones excluidas</h3><ul className="mt-2 space-y-2 text-sm">{r.exclusions.map((x, i) => <li key={i}>{c.alternatives.find(a => a.id === x.alternativeId)?.name ?? 'Opción'}: {reasons[x.reason] ?? 'Opción no válida'}</li>)}</ul></div>}
    </>}
    <details className="text-xs text-muted-foreground"><summary className="cursor-pointer py-3">Qué incluye este cálculo</summary><p>Excluye envío, cupones, membresías y condiciones de pago. Las repeticiones no garantizan stock suficiente.</p></details>
  </section>;
}
function Selection({ title, selection: s, c, products }: { title: string; selection: PurchaseResult['effective']; c: Configuration; products: ProductSummary[] }) {
  return <section className="space-y-3"><h3 className="font-medium">{title}</h3>{!s.searchComplete && <p className="text-sm">Cálculo limitado; optimalidad no demostrada.</p>}<ul className="space-y-3">{s.purchases.map(p => {
    const product = products.find(x => x.id === p.offer.productId);
    return <li key={p.offerId} className="rounded-xl border border-border p-3 text-sm">
    <p className="font-medium">{p.purchaseUnits} × {product?.name || 'Producto seguido'} · {purchaseMoney(p.convertedAmount, c.currency)}</p>
    {product && <a className="inline-block py-3 text-primary underline" href={product.url} target="_blank" rel="noopener noreferrer">{product.domain} ↗</a>}
    <p className="mt-2">Cubre: {p.offer.coverage.map(n => `${c.needs.find(x => x.id === n.needId)?.name ?? n.needId}: ${quantity(n.quantity)} ${unit(n.unit)} por compra`).join(' · ')}</p>
    <details className="text-xs text-muted-foreground"><summary className="cursor-pointer py-3">Precio y última lectura</summary><p>Precio: {purchaseMoney(p.offer.price, p.offer.currency)} · lectura {p.offer.priceCheckId} · {p.offer.lastSuccessAt ? new Date(p.offer.lastSuccessAt).toLocaleString('es-PE') : 'Sin lectura'}</p></details>
    {p.offer.coverage.length === 1 && <p className="mt-1 text-xs">Precio normalizado informativo: {quantity(String(Number(p.offer.price) / Number(p.offer.coverage[0].quantity)))} {p.offer.currency}/{p.offer.coverage[0].unit}</p>}
    {p.extras.map(x => <p key={x.id} className="mt-1">Extra {c.offers.find(o => o.id === p.offerId)?.extras.find(e => e.id === x.id)?.name}: {x.quantity} {x.unit} · {x.accepted ? 'aceptado' : 'sin aceptar'}</p>)}
  </li>; })}</ul></section>;
}

function quantity(value: string) { return new Intl.NumberFormat('es-PE', { maximumFractionDigits: 6 }).format(Number(value)); }
function unit(value: string) { return value === 'unit' ? 'unidades' : value; }
