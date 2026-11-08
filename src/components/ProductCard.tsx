import { lazy, Suspense, useState, type DragEvent } from 'react';
import { productMetrics, type ProductSummary } from '../lib/products';
import { ArrowDown, ArrowUp, Check, Clock3, ExternalLink, ImageOff, Pause, TriangleAlert } from 'lucide-react';
import { Button } from './ui/button';
import { Badge } from './ui/badge';
import { cn } from '../lib/utils';

const statuses = { active: 'Activo', paused: 'Pausado', error: 'Error', pending_confirmation: 'Por confirmar' };
const ProductSparkline = lazy(() => import('./ProductSparkline'));
export function formatPrice(value: number | null, currency: string | null) {
  if (value === null || !currency) return 'Sin precio';
  return `${currency === 'PEN' ? 'S/' : currency} ${new Intl.NumberFormat('es-PE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value)}`;
}

// An active product whose latest check did not produce a valid reading still shows its previous price.
export function staleReading(product: Pick<ProductSummary, 'status' | 'last_checked_at' | 'last_success_at'>) {
  if (product.status !== 'active' || product.last_checked_at === product.last_success_at) return null;
  return product.last_success_at ? 'stale' : 'pending';
}
const staleCopy = {
  stale: { badge: 'Precio desactualizado', text: ' La última revisión no obtuvo un precio válido; se muestra la lectura anterior.' },
  pending: { badge: 'Revisión pendiente', text: ' La última revisión no obtuvo un precio válido; se reintentará en la próxima revisión.' },
};

export function ProductCard({ product, onDetail, selection }: { product: ProductSummary; onDetail?: () => void; selection?: { selected: boolean; onToggle: () => void; onDragStart?: (event: DragEvent<HTMLButtonElement>) => void } }) {
  const [imageFailed, setImageFailed] = useState(false);
  const { target, reached, progress, variation } = productMetrics(product);
  const title = product.name || product.domain;
  const stale = staleReading(product);
  const updated = product.last_success_at ? new Intl.DateTimeFormat('es-PE', { dateStyle: 'short', timeStyle: 'short' }).format(new Date(product.last_success_at)) : null;
  const remaining = !reached && target !== null && product.last_price !== null && product.last_price > target ? product.last_price - target : null;
  const dimmed = product.status === 'paused' || product.status === 'error' || !!stale;
  return <article aria-labelledby={`product-${product.id}`} className={cn('relative isolate min-w-0 rounded-xl border bg-card transition-colors motion-safe:duration-150', selection?.selected ? 'border-foreground ring-1 ring-foreground' : 'border-border hover:border-border-strong')}>
    {selection && <button type="button" draggable onDragStart={selection.onDragStart} onClick={selection.onToggle} aria-pressed={selection.selected} aria-label={`${selection.selected ? 'Quitar de la selección' : 'Seleccionar'} ${title} · ${product.domain}`} title="Seleccionar esta tarjeta" className="absolute inset-0 z-0 w-full cursor-pointer rounded-xl outline-none focus-visible:focus-ring">
      <span aria-hidden="true" className={cn('absolute top-3 right-3 flex size-5 items-center justify-center rounded-md border', selection.selected ? 'border-foreground bg-foreground text-background' : 'border-border-strong bg-background/80 text-transparent')}><Check className="size-3.5" strokeWidth={3} /></span>
    </button>}
    <div className="pointer-events-none relative z-10 flex flex-col gap-3 p-3.5 sm:p-4">
      <div className={cn('flex items-start gap-3', selection && 'pr-7')}>
        <div className="flex size-14 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-muted">
          {product.image_url && !imageFailed ? <img src={product.image_url} alt={title} loading="lazy" referrerPolicy="no-referrer" className="h-full w-full object-contain" onError={() => setImageFailed(true)} />
            : <span className="text-subtle-foreground"><ImageOff aria-hidden="true" className="size-5" strokeWidth={1.5} /><span className="sr-only">Sin imagen</span></span>}
        </div>
        <div className="min-w-0 flex-1 space-y-1">
          <h2 id={`product-${product.id}`} className="line-clamp-2 text-[15px] leading-snug font-medium [overflow-wrap:anywhere]">{title}</h2>
          <p className="truncate font-mono text-xs text-subtle-foreground">{product.domain}</p>
        </div>
        <div className="shrink-0 space-y-1 text-right">
          <p className={cn('text-[17px] font-semibold tracking-tight tabular-nums', dimmed ? 'text-muted-foreground' : reached ? 'text-good' : 'text-foreground')}>{formatPrice(product.last_price, product.currency)}</p>
          {variation === null ? <p className="text-xs text-subtle-foreground">Sin referencia</p>
            : <p className={cn('inline-flex items-center gap-0.5 text-xs font-semibold tabular-nums', variation < 0 ? 'text-good' : 'text-muted-foreground')}>
              {variation < 0 ? <ArrowDown aria-hidden="true" className="size-3" strokeWidth={3} /> : variation > 0 ? <ArrowUp aria-hidden="true" className="size-3" strokeWidth={3} /> : null}
              {`${new Intl.NumberFormat('es-PE', { maximumFractionDigits: 1 }).format(Math.abs(variation))} %`}<span className="sr-only">{variation < 0 ? ' por debajo de la referencia' : variation > 0 ? ' por encima de la referencia' : ' igual a la referencia'}</span>
            </p>}
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-1.5 empty:hidden">
        {product.status === 'active' ? <span className="sr-only">{statuses.active}</span>
          : <Badge tone={product.status === 'error' ? 'destructive' : product.status === 'pending_confirmation' ? 'info' : 'neutral'}>{product.status === 'error' ? <TriangleAlert aria-hidden="true" /> : product.status === 'paused' ? <Pause aria-hidden="true" /> : null}{statuses[product.status]}</Badge>}
        {stale && <Badge tone="warn"><Clock3 aria-hidden="true" />{staleCopy[stale].badge}</Badge>}
        {reached && <Badge tone="good"><Check aria-hidden="true" strokeWidth={3} />Meta alcanzada</Badge>}
      </div>
      <div className="flex items-end gap-3">
        <div className="min-w-0 flex-1 space-y-1.5">
          <p className="flex flex-wrap justify-between gap-x-2 text-xs tabular-nums"><span className="text-muted-foreground">Tu meta</span><span>{target === null ? 'Sin meta' : formatPrice(target, product.currency)}{product.target_type === 'percent' && product.target_percent !== null ? ` (−${product.target_percent} %)` : ''}</span></p>
          {progress !== null ? <div role="progressbar" aria-label={`Progreso hacia la meta de ${title}`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(progress)} className="h-1 overflow-hidden rounded-full bg-muted"><div className={cn('h-full rounded-full', reached ? 'bg-good' : 'bg-foreground')} style={{ width: `${progress}%` }} /></div>
            : <p className="text-xs text-subtle-foreground">Sin datos para calcular el progreso.</p>}
          {remaining !== null && <p className="text-xs text-muted-foreground tabular-nums">Faltan {formatPrice(remaining, product.currency)} para tu meta</p>}
        </div>
        {product.history.length > 1 ? <div role="img" aria-label={`Evolución del precio de ${title}: de ${formatPrice(product.history[0].price, product.currency)} a ${formatPrice(product.history[product.history.length - 1].price, product.currency)}`} className="h-8 w-20 shrink-0">
          <Suspense fallback={<div className="h-full rounded bg-elevated motion-safe:animate-pulse" />}><ProductSparkline history={product.history} /></Suspense>
        </div> : <p className="w-24 shrink-0 text-right text-[11px] leading-tight text-subtle-foreground">{product.history.length ? 'La tendencia aparecerá tras otra lectura.' : 'Todavía no hay historial.'}</p>}
      </div>
      <p className={cn('text-xs leading-relaxed', stale ? 'text-warn' : 'text-subtle-foreground')}>{updated ? <>Precio leído el <time dateTime={product.last_success_at!}>{updated}</time>.</> : 'Aún no hay una lectura válida.'}{product.status === 'error' && ' La última revisión falló.'}{product.status === 'paused' && ' Las revisiones están pausadas.'}{stale && staleCopy[stale].text}</p>
      <div className="pointer-events-auto grid grid-cols-2 gap-2">
        {onDetail && <Button size="sm" variant="outline" onClick={onDetail} aria-label={`Ver detalle de ${title}`}>Ver detalle</Button>}
        <a href={product.url} target="_blank" rel="noopener noreferrer" className={cn('inline-flex min-h-9 items-center justify-center gap-1.5 rounded-lg px-3 text-[13px] font-medium text-muted-foreground transition-colors outline-none hover:bg-elevated hover:text-foreground focus-visible:focus-ring', !onDetail && 'col-span-2')} aria-label={`Abrir tienda de ${title}`}>Abrir tienda <ExternalLink aria-hidden="true" className="size-3.5" /></a>
      </div>
    </div>
  </article>;
}
