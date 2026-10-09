import { lazy, Suspense, useEffect, useRef, useState, type FormEvent } from 'react';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { formatPrice } from './ProductCard';
import { productAction, productMetrics, requestDetail, percentageTarget, type ProductDetail, type ProductEdit, type HistoryRange } from '../lib/products';
import { historyRanges, validProductEdit } from '../../lib/detail-contract';
import { intervals } from '../../lib/product-contract';
import type { List } from '../lib/lists';

const ProductHistory = lazy(() => import('./ProductHistory'));
const selectClass = 'mt-2 h-12 w-full min-w-0 rounded-lg border border-input bg-card px-3 text-sm focus-visible:outline-2 focus-visible:outline-ring';
const statuses = { active: 'Activo', paused: 'Pausado', error: 'Error', pending_confirmation: 'Por confirmar' };
type Props = { id: string; lists: List[]; onBack: () => void; onDeleted: () => void; onExpired: (message: string) => void };

export function ProductDetailScreen({ id, lists, onBack, onDeleted, onExpired }: Props) {
  const [detail, setDetail] = useState<ProductDetail | null>(null);
  const [range, setRange] = useState<HistoryRange>('30');
  const [refresh, setRefresh] = useState(0);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [edit, setEdit] = useState<ProductEdit | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [reviewQueued, setReviewQueued] = useState<string | null | undefined>(undefined);
  const submitting = useRef(false);
  const expired = useRef(onExpired);
  expired.current = onExpired;
  const title = useRef<HTMLHeadingElement>(null);
  useEffect(() => { title.current?.focus(); }, []);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setError('');
    requestDetail(id, range, controller.signal).then(data => {
      if (controller.signal.aborted) return;
      setDetail(data);
      document.title = `Scrappy · ${data.product.name || data.product.domain}`;
      setReviewQueued(current => current !== undefined && current !== data.product.last_checked_at ? undefined : current);
    }).catch((failure: { status: number; message: string }) => {
      if (controller.signal.aborted) return;
      if (failure.status === 401) expired.current(failure.message); else setError(failure.message);
    }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [id, range, refresh]);

  async function act(action: 'edit' | 'pause' | 'resume' | 'delete' | 'review') {
    if (submitting.current || !detail) return;
    submitting.current = true; setBusy(true); setError(''); setNotice('');
    try {
      await productAction(id, action, edit ?? undefined);
      if (action === 'delete') { onDeleted(); return; }
      if (action === 'review') {
        setReviewQueued(detail.product.last_checked_at);
        setNotice('Revisión solicitada. Pulsa Actualizar detalle en unos momentos para consultar el resultado.');
      } else {
        setEdit(null); setNotice(action === 'pause' ? 'Revisiones pausadas.' : action === 'resume' ? 'Producto reanudado.' : 'Cambios guardados.');
        setRefresh(value => value + 1);
      }
    } catch (failure) {
      const e = failure as { status: number; message: string };
      if (e.status === 401) expired.current(e.message); else setError(e.message);
    } finally { submitting.current = false; setBusy(false); }
  }

  function beginEdit() {
    if (!detail) return;
    const p = detail.product;
    setEdit({ name: p.name || p.domain, list_id: p.list_id, reference_price: String(p.reference_price ?? ''),
      target_type: p.target_type ?? 'price', target_value: String((p.target_type === 'percent' ? p.target_percent : p.target_price) ?? ''), check_interval_hours: p.check_interval_hours });
    setDeleting(false); setError('');
  }
  function save(event: FormEvent) {
    event.preventDefault();
    if (!validProductEdit(edit)) { setError('Revisa el nombre, referencia positiva, meta e intervalo.'); return; }
    void act('edit');
  }
  const p = detail?.product;
  const metrics = p ? productMetrics(p) : null;
  const stats = detail?.statistics;
  let equivalent = '';
  if (edit?.target_type === 'percent' && validProductEdit(edit)) equivalent = percentageTarget(edit.reference_price, edit.target_value);

  return <section aria-labelledby="detail-title" aria-busy={loading || busy} className="mx-auto w-full min-w-0 max-w-4xl self-start">
    <Button variant="outline" onClick={onBack} disabled={busy}>← Volver a Inicio</Button>
    <div className="mt-7 mb-6 min-w-0">
      <p className="mb-2 text-xs tracking-[0.16em] text-primary uppercase">Detalle de producto</p>
      <h1 ref={title} tabIndex={-1} id="detail-title" className="text-3xl font-semibold tracking-tight outline-none [overflow-wrap:anywhere]">{p?.name || p?.domain || 'Tu producto'}</h1>
      {p && <p className="mt-3 text-sm text-muted-foreground [overflow-wrap:anywhere]">{p.domain} · {statuses[p.status]} · cada {p.check_interval_hours} h</p>}
    </div>
    {error && <p role="alert" className="mb-4 text-sm text-destructive">{error}</p>}
    <p role="status" className="mb-4 text-sm text-primary">{loading ? 'Cargando detalle…' : notice}</p>
    <Button variant="outline" disabled={loading || busy} onClick={() => setRefresh(value => value + 1)}>Actualizar detalle</Button>
    {!detail && loading && <div aria-hidden="true" className="mt-6 h-96 rounded-2xl border border-border bg-card motion-safe:animate-pulse" />}
    {detail && p && stats && <>
      <div className="mt-6 grid min-w-0 gap-4 rounded-2xl border border-border bg-card p-5 sm:grid-cols-3">
        <div><p className="text-xs text-muted-foreground">Último precio conocido</p><p className="mt-2 text-3xl font-semibold tabular-nums [overflow-wrap:anywhere]">{formatPrice(p.last_price, p.currency)}</p></div>
        <div><p className="text-xs text-muted-foreground">Tu meta{metrics?.reached ? ' · alcanzada' : ''}</p><p className="mt-2 text-lg tabular-nums [overflow-wrap:anywhere]">{formatPrice(metrics?.target ?? null, p.currency)}</p></div>
        <div><p className="text-xs text-muted-foreground">Referencia</p><p className="mt-2 text-lg tabular-nums [overflow-wrap:anywhere]">{formatPrice(p.reference_price, p.currency)}</p></div>
      </div>
      <div className="mt-6 min-w-0 rounded-2xl border border-border bg-card p-4 sm:p-6">
        <h2 className="text-lg font-medium">Historial de precios</h2>
        <div aria-label="Rango del historial" className="mt-4 flex flex-wrap gap-2">{historyRanges.map(value => <Button key={value} variant={range === value ? 'default' : 'outline'} aria-pressed={range === value} disabled={busy || loading} onClick={() => setRange(value)}>{value === 'all' ? 'Todo' : `${value} días`}</Button>)}</div>
        {detail.history.length ? <div role="img" aria-label={`Historial con ${detail.history.length} precios válidos, meta y referencia`} className="mt-5 h-64 min-w-0"><Suspense fallback={<p className="text-sm text-muted-foreground">Cargando gráfico…</p>}><ProductHistory detail={detail} /></Suspense></div>
          : <p className="py-10 text-sm text-muted-foreground">No hay precios válidos en este rango. Prueba «Todo» o solicita una revisión.</p>}
        <p className="mt-3 text-xs text-muted-foreground">Línea verde: precio · discontinua verde: meta · discontinua gris: referencia.</p>
      </div>
      <div className="mt-6 rounded-2xl border border-border bg-card p-5">
        <h2 className="text-lg font-medium">Estadísticas históricas</h2><p className="mt-2 text-xs text-muted-foreground">{stats.count} lecturas válidas de {p.currency || 'moneda sin confirmar'} · todo el historial</p>
        <dl className="mt-5 grid min-w-0 grid-cols-1 gap-5 sm:grid-cols-3">{([['Mínimo', stats.min], ['Máximo', stats.max], ['Promedio', stats.average]] as const).map(([label, value]) => <div key={label}><dt className="text-sm text-muted-foreground">{label}</dt><dd className="mt-1 text-xl tabular-nums [overflow-wrap:anywhere]">{value === null ? 'Sin datos' : formatPrice(value, p.currency)}</dd></div>)}</dl>
        <p className="mt-5 text-sm text-muted-foreground">Tendencia del descuento: {stats.discount_change === null ? 'se necesitan dos lecturas y una referencia positiva.' : `${stats.discount_change > 0 ? '+' : ''}${new Intl.NumberFormat('es-PE', { maximumFractionDigits: 1 }).format(stats.discount_change)} puntos porcentuales desde la primera lectura.`}</p>
      </div>
      <div className="mt-6 flex flex-wrap gap-3">
        <Button variant="outline" disabled={busy || loading || p.status === 'pending_confirmation'} onClick={beginEdit}>Editar</Button>
        <Button variant="outline" disabled={busy || loading || p.status === 'pending_confirmation'} onClick={() => void act(p.status === 'paused' ? 'resume' : 'pause')}>{p.status === 'paused' ? 'Reanudar' : 'Pausar'}</Button>
        <Button disabled={busy || loading || !['active', 'error'].includes(p.status) || reviewQueued !== undefined} onClick={() => void act('review')}>Revisar ahora</Button>
        <Button variant="outline" disabled={busy || loading} onClick={() => { setDeleting(true); setEdit(null); }}>Eliminar</Button>
        <Button variant="outline" asChild><a href={p.url} target="_blank" rel="noopener noreferrer">Abrir tienda ↗</a></Button>
      </div>
      {reviewQueued !== undefined && <p className="mt-3 text-xs text-muted-foreground">Revisión pendiente de resultado. Si falla, actualiza el historial antes de reintentar. <button className="underline" disabled={busy || loading} onClick={() => setReviewQueued(undefined)}>Permitir otro intento</button></p>}
      {deleting && <div role="group" aria-label="Confirmar eliminación" className="mt-5 rounded-xl border border-destructive/40 p-5"><p className="text-sm">Se eliminarán el producto y todo su historial de precios.</p><div className="mt-4 flex flex-wrap gap-3"><Button disabled={busy} onClick={() => void act('delete')}>Eliminar definitivamente</Button><Button variant="outline" disabled={busy} onClick={() => setDeleting(false)}>Cancelar</Button></div></div>}
      {edit && <form onSubmit={save} aria-label="Editar producto" className="mt-5 grid min-w-0 gap-5 rounded-2xl border border-border bg-card p-5 sm:grid-cols-2">
        <label className="min-w-0 text-sm">Nombre<Input className="mt-2" value={edit.name} disabled={busy} required maxLength={300} onChange={e => setEdit({ ...edit, name: e.target.value })} /></label>
        <label className="min-w-0 text-sm">Lista<select className={selectClass} value={edit.list_id} disabled={busy} onChange={e => setEdit({ ...edit, list_id: e.target.value })}>{lists.map(list => <option key={list.id} value={list.id}>{list.name}</option>)}</select></label>
        <label className="min-w-0 text-sm">Precio de referencia ({p.currency})<Input className="mt-2" inputMode="decimal" value={edit.reference_price} disabled={busy} required onChange={e => setEdit({ ...edit, reference_price: e.target.value.replace(',', '.') })} /></label>
        <label className="min-w-0 text-sm">Tipo de meta<select className={selectClass} value={edit.target_type} disabled={busy} onChange={e => setEdit({ ...edit, target_type: e.target.value as ProductEdit['target_type'], target_value: '' })}><option value="price">Precio máximo</option><option value="percent">Descuento porcentual</option></select></label>
        <label className="min-w-0 text-sm">{edit.target_type === 'percent' ? 'Descuento (%)' : `Precio meta (${p.currency})`}<Input className="mt-2" inputMode="decimal" value={edit.target_value} disabled={busy} required onChange={e => setEdit({ ...edit, target_value: e.target.value.replace(',', '.') })} />{equivalent && <span className="mt-2 block text-xs text-primary">Equivale a {formatPrice(Number(equivalent), p.currency)}</span>}</label>
        <label className="min-w-0 text-sm">Intervalo<select className={selectClass} value={edit.check_interval_hours} disabled={busy} onChange={e => setEdit({ ...edit, check_interval_hours: Number(e.target.value) })}>{intervals.map(hours => <option key={hours} value={hours}>Cada {hours} horas</option>)}</select></label>
        <div className="flex flex-wrap gap-3 sm:col-span-2"><Button type="submit" disabled={busy}>Guardar cambios</Button><Button type="button" variant="outline" disabled={busy} onClick={() => setEdit(null)}>Cancelar edición</Button></div>
      </form>}
      <div className="mt-8"><h2 className="text-lg font-medium">Últimas revisiones</h2><p className="mt-2 text-xs text-muted-foreground">Los intentos fallidos y lecturas de otras monedas no cuentan en las estadísticas.</p>
        {detail.reviews.length ? <ol className="mt-5 divide-y divide-border">{detail.reviews.map(review => <li key={review.id} className="flex min-w-0 flex-wrap justify-between gap-2 py-4 text-sm"><div className="min-w-0"><time dateTime={review.checked_at} className="text-muted-foreground">{new Intl.DateTimeFormat('es-PE', { dateStyle: 'short', timeStyle: 'short' }).format(new Date(review.checked_at))}</time><p className="mt-1 [overflow-wrap:anywhere]">{review.ok ? 'Lectura válida' : `Lectura fallida${review.error_code ? ` · ${review.error_code}` : ''}`}{review.method ? ` · ${review.method}` : ''}</p></div><span className="tabular-nums [overflow-wrap:anywhere]">{formatPrice(review.price, review.currency)}</span></li>)}</ol> : <p className="mt-4 text-sm text-muted-foreground">Todavía no hay revisiones.</p>}
      </div>
    </>}
  </section>;
}
