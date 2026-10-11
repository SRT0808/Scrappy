import type { Basket } from '../lib/baskets';

export function BasketSummary({ basket }: { basket: Basket }) {
  const money = (value: number | null) => value === null ? 'Sin datos' : `${basket.currency === 'PEN' ? 'S/' : basket.currency} ${value.toLocaleString('es-PE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const reached = basket.complete && basket.total !== null && basket.budget !== null && basket.total <= basket.budget;
  return <section aria-label="Resumen de canasta" className="mb-5 min-w-0 rounded-xl border border-border bg-card p-4 [overflow-wrap:anywhere]">
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div><h2 className="text-sm font-medium">Canasta · {basket.currency}</h2><p className="mt-2 text-2xl font-semibold tabular-nums">{money(basket.total)}</p><p className="mt-1 text-xs text-muted-foreground">{basket.complete ? 'Total actual' : 'Total estimado / subtotal conocido'} · gasto máximo {money(basket.budget)}</p></div>
      <span className={reached ? 'text-sm text-primary' : 'text-sm text-muted-foreground'}>{!basket.complete ? 'Canasta incompleta' : reached ? 'Gasto objetivo alcanzado' : basket.budget === null ? 'Sin meta agregada' : 'Sobre el gasto máximo'}</span>
    </div>
    <p className="mt-3 text-xs leading-relaxed text-muted-foreground">{basket.valid_count} de {basket.product_count} precios válidos en {basket.currency}. Cantidades de cada línea, incluidos los pausados. {!basket.complete && 'Sin aviso hasta completar precios y conversión vigentes.'}</p>
    {basket.reference_total !== undefined && <dl className="mt-4 grid gap-3 text-sm sm:grid-cols-3">
      <div><dt className="text-muted-foreground">Referencia</dt><dd>{money(basket.reference_total)}</dd></div>
      <div><dt className="text-muted-foreground">Ahorro{!basket.complete && ' estimado'}</dt><dd>{money(basket.savings ?? null)} · {basket.savings_percent ?? '—'} %</dd></div>
      <div><dt className="text-muted-foreground">Meta equivalente</dt><dd>{basket.budget !== null && basket.reference_total !== null && basket.reference_total > 0 ? `${((1-basket.budget/basket.reference_total)*100).toFixed(2)} %` : 'Sin datos'}</dd></div>
    </dl>}
    {basket.stale_count !== undefined && <p className="mt-3 text-xs text-muted-foreground">{basket.missing_count} sin precio · {basket.stale_count} desactualizados · {basket.unavailable_count} agotados · {basket.fx_missing_count} sin conversión vigente</p>}
    {basket.exchange_rates?.map((fx,i) => <p key={i} className="mt-2 text-xs text-muted-foreground">{fx.from} → {fx.to}: {fx.rate} · {fx.date} · {fx.source}</p>)}
  </section>;
}
