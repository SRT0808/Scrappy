import { lazy, Suspense, useState } from 'react';
import { productMetrics, type ProductSummary } from '../lib/products';
import { Button } from './ui/button';

const statuses = { active: 'Activo', paused: 'Pausado', error: 'Error', pending_confirmation: 'Por confirmar' };
const ProductSparkline = lazy(() => import('./ProductSparkline'));
export function formatPrice(value: number | null, currency: string | null) {
  if (value === null || !currency) return 'Sin precio';
  return `${currency === 'PEN' ? 'S/' : currency} ${new Intl.NumberFormat('es-PE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value)}`;
}

export function ProductCard({ product, onDetail }: { product: ProductSummary; onDetail?: () => void }) {
  const [imageFailed, setImageFailed] = useState(false);
  const { target, reached, progress, variation } = productMetrics(product);
  const title = product.name || product.domain;
  const updated = product.last_success_at ? new Intl.DateTimeFormat('es-PE', { dateStyle: 'short', timeStyle: 'short' }).format(new Date(product.last_success_at)) : null;
  return <article aria-labelledby={`product-${product.id}`} className="min-w-0 overflow-hidden rounded-2xl border border-border bg-card">
    <div className="flex h-40 items-center justify-center border-b border-border bg-muted/40 p-5">
      {product.image_url && !imageFailed ? <img src={product.image_url} alt={title} loading="lazy" referrerPolicy="no-referrer" className="h-full w-full object-contain" onError={() => setImageFailed(true)} />
        : <div className="flex flex-col items-center gap-2 text-muted-foreground"><svg aria-hidden="true" width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.2"><rect x="3" y="3" width="18" height="18" rx="3" /><circle cx="8" cy="8" r="1.5" /><path d="m3 17 5-5 4 4 4-6 5 7" /></svg><span className="text-xs">Sin imagen</span></div>}
    </div>
    <div className="space-y-5 p-5">
      {onDetail && <Button className="w-full" variant="outline" onClick={onDetail} aria-label={`Ver detalle de ${title}`}>Ver detalle</Button>}
      <div>
        <div className="mb-3 flex flex-wrap gap-2 text-xs">
          <span className={`rounded-full border px-2.5 py-1 ${product.status === 'error' ? 'border-destructive/40 text-destructive' : 'border-border text-muted-foreground'}`}>{statuses[product.status]}</span>
          {reached && <span className="rounded-full border border-primary/30 bg-primary/10 px-2.5 py-1 text-primary">Meta alcanzada</span>}
        </div>
        <h2 id={`product-${product.id}`} className="text-lg leading-snug font-medium [overflow-wrap:anywhere]">{title}</h2>
        <p className="mt-2 text-xs text-muted-foreground [overflow-wrap:anywhere]">{product.domain}</p>
      </div>
      <div>
        <p className="text-xs text-muted-foreground">Último precio conocido</p>
        <p className="mt-1 text-2xl font-semibold tracking-tight tabular-nums [overflow-wrap:anywhere]">{formatPrice(product.last_price, product.currency)}</p>
        <p className={`mt-2 text-sm tabular-nums ${variation !== null && variation < 0 ? 'text-primary' : 'text-muted-foreground'}`}>
          {variation === null ? 'Sin referencia comparable' : `${variation > 0 ? '+' : ''}${new Intl.NumberFormat('es-PE', { maximumFractionDigits: 1 }).format(variation)} % frente a referencia`}
        </p>
        {product.reference_price !== null && <p className="mt-1 text-xs text-muted-foreground tabular-nums">Referencia: {formatPrice(product.reference_price, product.currency)}</p>}
      </div>
      <div>
        <div className="flex flex-wrap justify-between gap-2 text-sm tabular-nums"><span className="text-muted-foreground">Tu meta</span><span>{target === null ? 'Sin meta' : formatPrice(target, product.currency)}{product.target_type === 'percent' && product.target_percent !== null ? ` (−${product.target_percent} %)` : ''}</span></div>
        {progress !== null ? <><div role="progressbar" aria-label={`Progreso hacia la meta de ${title}`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(progress)} className="mt-3 h-1.5 overflow-hidden rounded-full bg-muted"><div className="h-full rounded-full bg-primary" style={{ width: `${progress}%` }} /></div><p className="mt-2 text-xs text-muted-foreground">{Math.round(progress)} % del recorrido desde la referencia</p></>
          : <p className="mt-3 text-xs text-muted-foreground">Sin datos para calcular el progreso.</p>}
      </div>
      <div>
        <p className="text-xs text-muted-foreground">Últimas {product.history.length} lecturas válidas</p>
        {product.history.length > 1 ? <div role="img" aria-label={`Evolución del precio de ${title}: de ${formatPrice(product.history[0].price, product.currency)} a ${formatPrice(product.history[product.history.length - 1].price, product.currency)}`} className="mt-2 h-12 min-w-0">
          <Suspense fallback={<div className="h-full rounded bg-muted motion-safe:animate-pulse" />}><ProductSparkline history={product.history} /></Suspense>
        </div> : <p className="mt-2 text-xs text-muted-foreground">{product.history.length ? 'La tendencia aparecerá tras otra lectura.' : 'Todavía no hay historial.'}</p>}
      </div>
      <p className="text-xs leading-relaxed text-muted-foreground">{updated ? <>Precio leído el <time dateTime={product.last_success_at!}>{updated}</time>.</> : 'Aún no hay una lectura válida.'}{product.status === 'error' && ' La última revisión falló.'}{product.status === 'paused' && ' Las revisiones están pausadas.'}</p>
      <a href={product.url} target="_blank" rel="noopener noreferrer" className="flex min-h-11 items-center justify-center rounded-lg border border-border px-4 py-3 text-sm font-medium hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring" aria-label={`Abrir tienda de ${title}`}>Abrir tienda <span aria-hidden="true" className="ml-2">↗</span></a>
    </div>
  </article>;
}
