import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { basketStatistics, requestBasket, type BasketDetail } from '../lib/baskets';
import { requestProducts, type ProductSummary } from '../lib/products';
import { BasketSummary } from './BasketSummary';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { formatPrice } from './ProductCard';
const BasketHistory = lazy(() => import('./BasketHistory'));
const selectClass = 'mt-2 h-12 w-full min-w-0 rounded-lg border border-input bg-card px-3 text-sm';
const date = (value: string | null) => value ? new Date(value).toLocaleString('es-PE') : 'Sin lectura válida';

export function BasketDetailScreen({ id, historyOnly = false, onBack, onExpired }: { id: string; historyOnly?: boolean; onBack: () => void; onExpired: (message: string) => void }) {
  const [detail,setDetail] = useState<BasketDetail | null>(null);
  const [products,setProducts] = useState<ProductSummary[]>([]);
  const [range,setRange] = useState('30');
  const [version,setVersion] = useState<number | null>(null);
  const [refresh,setRefresh] = useState(0);
  const [busy,setBusy] = useState(false);
  const [error,setError] = useState('');
  const [loading,setLoading] = useState(true);
  const [productId,setProductId] = useState('');
  const [quantities,setQuantities] = useState<Record<string,string>>({});
  const [uncertain,setUncertain] = useState(false);
  const submitting = useRef(false);
  const expired = useRef(onExpired); expired.current=onExpired;
  function failure(e: unknown) {
    const problem = e as { status?: number; message?: string };
    if (problem.status === 401) expired.current(problem.message ?? 'Tu sesión ha caducado.');
    else setError(problem.message ?? 'No pudimos conectar. Actualiza antes de reintentar.');
  }
  useEffect(() => {
    const controller = new AbortController(); setLoading(true); setError(''); setDetail(null);
    Promise.all([requestBasket(id,range,undefined,controller.signal),requestProducts('',controller.signal)]).then(([d,p]) => {
      if (controller.signal.aborted) return;
      setDetail(d); setProducts(p); setVersion(v => v !== null && d.versions.includes(v) ? v : d.basket.composition_version!);
      setQuantities(Object.fromEntries(d.basket.lines!.map(l => [l.product_id,String(l.quantity)]))); setUncertain(false);
    }).catch(e => { if (!controller.signal.aborted) failure(e); }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  },[id,range,refresh]);
  async function mutate(product_id: string, quantity: number | null) {
    if (!detail || submitting.current || uncertain || loading) return;
    if (quantity !== null && (!Number.isInteger(quantity) || quantity < 1 || quantity > 2147483647)) { setError('Indica una cantidad entera positiva.'); return; }
    submitting.current=true; setBusy(true); setError('');
    try {
      const d = await requestBasket(id,range,{ product_id,quantity,version:detail.basket.composition_version! });
      setDetail(d); setVersion(d.basket.composition_version!); setProductId('');
      setQuantities(Object.fromEntries(d.basket.lines!.map(l => [l.product_id,String(l.quantity)])));
    } catch (e) { failure(e); setUncertain(true); }
    finally { submitting.current=false; setBusy(false); }
  }
  const points=detail?.snapshots.filter(p => p.composition_version===version) ?? [];
  const stats=basketStatistics(points,version ?? 0);
  const currency=points[0]?.currency ?? detail?.basket.currency ?? 'PEN';
  const available=products.filter(p => !detail?.basket.lines?.some(l => l.product_id===p.id));
  const Heading = historyOnly ? 'h2' : 'h1';
  return <section className="mx-auto w-full min-w-0 max-w-4xl" aria-busy={loading || busy}>
    <Button variant="outline" disabled={busy} onClick={onBack}>{historyOnly ? 'Volver al resumen' : '← Volver a Canastas'}</Button>
    <Heading className="mt-6 mb-4 break-words text-3xl font-semibold">{historyOnly ? 'Historial de la canasta' : detail?.name ?? 'Detalle de canasta'}</Heading>
    {error && <p role="alert" className="mb-4 text-sm text-destructive">{error}</p>}
    <p role="status" className="mb-4 text-sm text-primary">{loading ? 'Cargando canasta…' : busy ? 'Guardando…' : ''}</p>
    <Button variant="outline" disabled={loading || busy} onClick={() => setRefresh(n => n+1)}>Actualizar canasta</Button>
    {detail && <>
      {!historyOnly && <><div className="mt-5"><BasketSummary basket={detail.basket} /></div>
      <section className="rounded-2xl border border-border bg-card p-4 sm:p-6">
        <h2 className="text-lg font-medium">Productos y frescura</h2>
        <ol className="mt-4 divide-y divide-border">{detail.basket.lines!.map(l => {
          const p=products.find(p => p.id===l.product_id);
          return <li key={l.product_id} className="min-w-0 py-4 [overflow-wrap:anywhere]">
            <h3 className="font-medium">{p?.name || p?.domain || l.product_id}</h3>
            <p className="mt-2 text-sm text-muted-foreground">{formatPrice(l.last_price,l.currency)} · {l.unavailable ? 'Agotado' : l.stale ? 'Precio desactualizado' : l.last_price === null ? 'Precio faltante' : l.valid ? 'Precio válido' : 'Conversión no vigente'}</p>
            <p className="mt-1 text-xs text-muted-foreground">Último precio válido: {date(l.last_success_at)} · última revisión: {date(l.last_checked_at)}</p>
            {l.conversion && <p className="mt-1 text-xs text-muted-foreground">{l.conversion.from} → {l.conversion.to}: {l.conversion.rate} · {l.conversion.date} · {l.conversion.source}</p>}
            <form className="mt-3 flex flex-wrap items-end gap-2" onSubmit={e => { e.preventDefault(); void mutate(l.product_id,Number(quantities[l.product_id])); }}>
              <label className="min-w-0 text-sm">Cantidad<Input className="mt-2 w-24" inputMode="numeric" value={quantities[l.product_id] ?? ''} disabled={busy || uncertain} onChange={e => setQuantities(q => ({ ...q,[l.product_id]:e.target.value }))} /></label>
              <Button type="submit" variant="outline" disabled={busy || uncertain}>Guardar cantidad</Button>
              <Button type="button" variant="outline" disabled={busy || uncertain} onClick={() => void mutate(l.product_id,null)}>Quitar</Button>
              {p && <a className="py-3 text-sm text-primary underline" href={p.url} target="_blank" rel="noopener noreferrer">Abrir tienda ↗</a>}
            </form>
          </li>;
        })}</ol>
        {!detail.basket.lines!.length && <p className="mt-4 text-sm text-muted-foreground">Agrega productos de tu catálogo a esta canasta.</p>}
        <form className="mt-5 space-y-3" onSubmit={e => { e.preventDefault(); if (productId) void mutate(productId,1); }}>
          <label className="block text-sm">Producto existente<select className={selectClass} value={productId} disabled={busy || uncertain} onChange={e => setProductId(e.target.value)}><option value="">Elige un producto</option>{available.map(p => <option key={p.id} value={p.id}>{p.name || p.domain}</option>)}</select></label>
          <Button disabled={busy || uncertain || !productId}>Agregar a canasta</Button>
        </form>
      </section>
      </>}
      <section className="mt-6 min-w-0 rounded-2xl border border-border bg-card p-4 sm:p-6">
        <h2 className="text-lg font-medium">Historial por composición</h2>
        <p className="mt-2 text-xs text-muted-foreground">Cada versión conserva sus cantidades y moneda. Las series nunca se mezclan.</p>
        <label className="mt-4 block text-sm">Composición<select className={selectClass} value={version ?? ''} disabled={busy || loading} onChange={e => setVersion(Number(e.target.value))}>{detail.versions.map(v => <option key={v} value={v}>Versión {v}{v===detail.basket.composition_version ? ' · actual' : ''}</option>)}</select></label>
        <div className="mt-4 flex flex-wrap gap-2">{['7','14','30','90','all'].map(r => <Button key={r} variant={range===r ? 'default' : 'outline'} aria-pressed={range===r} disabled={busy || loading} onClick={() => setRange(r)}>{r==='all' ? 'Todo' : `${r} días`}</Button>)}</div>
        {points.length ? <div role="img" aria-label="Gráfico de referencia, total completo y estimado" className="mt-5 h-64 min-w-0"><Suspense fallback={<p>Cargando gráfico…</p>}><BasketHistory points={points} budget={version===detail.basket.composition_version ? detail.basket.budget : null} /></Suspense></div> : <p className="my-8 text-sm text-muted-foreground">Sin snapshots en esta composición y rango.</p>}
        <p className="mt-3 text-xs text-muted-foreground">Verde: total completo · ámbar: estimado · gris: referencia · discontinua verde: meta actual.</p>
        <ol className="mt-4 max-h-48 overflow-y-auto text-xs text-muted-foreground">{points.map(p => <li key={p.id} className="flex flex-wrap justify-between gap-2 py-2"><span>{date(p.calculated_at)} · {p.complete ? 'Completo' : 'Estimado / incompleto'}</span><span>{formatPrice(p.current_total,p.currency)} · ahorro {formatPrice(p.savings,p.currency)} ({p.savings_percent ?? '—'} %)</span></li>)}</ol>
      </section>
      <section className="mt-6 rounded-2xl border border-border bg-card p-5">
        <h2 className="text-lg font-medium">Estadísticas descriptivas</h2>
        <p className="mt-2 text-xs text-muted-foreground">Solo snapshots completos de la composición y rango seleccionados. {stats.count} snapshots · {Math.floor(stats.days)} días observados.</p>
        {!stats.eligible ? <p className="mt-4 text-sm text-muted-foreground">Se necesitan al menos 14 días y 10 snapshots completos. Prueba un rango mayor.</p> : <>
          <p className="mt-3 text-xs text-muted-foreground">{date(stats.first)} — {date(stats.last)}</p>
          <dl className="mt-4 grid gap-4 sm:grid-cols-2">{[['Mínimo',formatPrice(stats.min.current_total,currency),date(stats.min.calculated_at)],['Máximo',formatPrice(stats.max.current_total,currency),date(stats.max.calculated_at)],['Promedio',formatPrice(stats.average,currency),''],['Mediana',formatPrice(stats.median,currency),'']].map(([label,value,at]) => <div key={label}><dt className="text-sm text-muted-foreground">{label}</dt><dd className="mt-1 text-lg tabular-nums">{value}</dd>{at && <p className="text-xs text-muted-foreground">{at}</p>}</div>)}</dl>
          <p className="mt-4 text-sm text-muted-foreground">El último total completo está {points.filter(p => p.complete).at(-1)!.current_total! < stats.median ? 'por debajo de' : 'igual o por encima de'} la mediana observada. Estos datos describen el historial; no predicen precios futuros.</p>
        </>}
      </section>
    </>}
  </section>;
}
