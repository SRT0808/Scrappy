import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Button } from './ui/button';
import { loadSettings, saveInterval, sendTest, type Settings, type Delivery } from '../lib/settings';

type Props = { onBack: () => void; onExpired: (message: string) => void };
const date = (value: string) => new Date(value).toLocaleString('es-PE');
const types: Record<string, string> = { test: 'Prueba', goal_reached: 'Meta alcanzada', dropped_further: 'Nueva bajada', extraction_failed: 'Error de lectura', suspicious_change: 'Precio sospechoso', heartbeat: 'Latido' };
export function SettingsScreen({ onBack, onExpired }: Props) {
  const [data, setData] = useState<Settings | null>(null);
  const [interval, setInterval] = useState(6);
  const [page, setPage] = useState(0);
  const [refresh, setRefresh] = useState(0);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [deliveries, setDeliveries] = useState<Delivery[]>([]);
  const lock = useRef(false);
  const expired = useRef(onExpired);
  expired.current = onExpired;
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setError(''); setData(null);
    loadSettings(page, controller.signal).then(value => {
      if (controller.signal.aborted) return;
      setData(value); setInterval(value.default_interval_hours);
    }).catch((failure: { status: number; message: string }) => {
      if (controller.signal.aborted) return;
      if (failure.status === 401) expired.current(failure.message); else setError(failure.message);
    }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [page, refresh]);
  async function act(action: 'save' | 'test') {
    if (lock.current) return;
    lock.current = true; setBusy(true); setError(''); setNotice('');
    if (action === 'test') setDeliveries([]);
    try {
      if (action === 'save') {
        await saveInterval(interval);
        setData(current => current && { ...current, default_interval_hours: interval });
        setNotice('Intervalo guardado. Se aplicará a los nuevos productos.');
      } else {
        const result = await sendTest(); setDeliveries(result);
        setPage(0); setRefresh(value => value + 1);
      }
    } catch (failure) {
      const value = failure as { status: number; message: string };
      if (value.status === 401) expired.current(value.message); else setError(value.message);
    } finally { lock.current = false; setBusy(false); }
  }
  const disabled = loading || busy;
  const run = data?.last_run;
  return <section aria-labelledby="settings-title" aria-busy={disabled} className="mx-auto w-full min-w-0 max-w-3xl self-start">
    <div className="mb-7 flex flex-wrap items-start justify-between gap-4"><div><p className="mb-2 text-xs font-medium tracking-[0.16em] text-primary uppercase">Tu radar de precios</p><h1 id="settings-title" className="text-3xl font-semibold tracking-tight">Ajustes</h1><p className="mt-3 text-sm text-muted-foreground">Configura tus revisiones y comprueba tus avisos.</p></div><Button variant="outline" disabled={busy} onClick={onBack}>Volver a Inicio</Button></div>
    {error && <p role="alert" className="mb-4 text-sm text-destructive">{error}</p>}
    <p role="status" className="mb-4 text-sm text-primary">{loading ? 'Cargando ajustes…' : busy ? 'Procesando…' : notice}</p>
    {loading && !data ? <div aria-hidden="true" className="h-64 rounded-2xl border border-border bg-card motion-safe:animate-pulse" /> : data && <div className="space-y-5">
      <section aria-labelledby="interval-title" className="rounded-2xl border border-border bg-card p-5 sm:p-6"><h2 id="interval-title" className="text-lg font-semibold">Frecuencia de revisión</h2><p className="mt-2 text-sm text-muted-foreground">Solo cambia el intervalo de los productos que añadas a partir de ahora.</p>
        <form onSubmit={(event: FormEvent) => { event.preventDefault(); void act('save'); }} className="mt-5 flex min-w-0 flex-col gap-4 sm:flex-row sm:items-end"><label className="min-w-0 flex-1 text-sm" htmlFor="default-interval">Intervalo por defecto<select id="default-interval" value={interval} disabled={disabled} onChange={event => setInterval(Number(event.target.value))} className="mt-2 h-12 w-full rounded-lg border border-input bg-background px-3 focus-visible:outline-2 focus-visible:outline-ring">{[3, 6, 12, 24].map(hours => <option key={hours} value={hours}>Cada {hours} horas</option>)}</select></label><Button disabled={disabled || interval === data.default_interval_hours}>Guardar intervalo</Button></form>
      </section>
      <section aria-labelledby="channels-title" className="rounded-2xl border border-border bg-card p-5 sm:p-6"><h2 id="channels-title" className="text-lg font-semibold">Canales de notificación</h2><p className="mt-2 text-sm text-muted-foreground">Envía un aviso de prueba a ntfy y a tu correo configurado.</p><Button className="mt-5 h-auto min-h-11 max-w-full whitespace-normal" disabled={disabled} onClick={() => void act('test')}>Enviar notificación de prueba</Button>
        {deliveries.length > 0 && <ul aria-live="polite" className="mt-4 space-y-2 text-sm">{deliveries.map(d => <li key={d.channel} className={d.status === 'failed' || !d.recorded ? 'text-destructive' : 'text-primary'}>{d.channel === 'email' ? 'Correo' : 'ntfy'}: {d.status === 'sent' ? 'enviada' : 'falló el envío'}.{!d.recorded && ' No se pudo registrar el intento; evita repetirlo sin comprobar el canal.'}</li>)}</ul>}
      </section>
      <section aria-labelledby="run-title" className="rounded-2xl border border-border bg-card p-5 sm:p-6"><h2 id="run-title" className="text-lg font-semibold">Última ejecución</h2>{run ? <div className="mt-4 space-y-2 text-sm"><p className={run.fail_count ? 'text-destructive' : 'text-primary'}>{run.finished_at ? run.fail_count ? 'Finalizada con errores' : 'Finalizada' : 'Sin finalizar'}</p><p className="text-muted-foreground">{run.trigger === 'cron' ? 'Programada' : run.trigger === 'dispatch' ? 'Manual' : 'Local'} · {date(run.started_at)}</p>{run.finished_at && <p className="text-muted-foreground">Fin: {date(run.finished_at)}</p>}<p className="tabular-nums">{run.checked} revisados · {run.ok_count} correctos · {run.fail_count} fallidos</p></div> : <p className="mt-3 text-sm text-muted-foreground">Todavía no hay ejecuciones registradas.</p>}</section>
      <section aria-labelledby="notifications-title" className="rounded-2xl border border-border bg-card p-5 sm:p-6"><h2 id="notifications-title" className="text-lg font-semibold">Historial de notificaciones</h2>{data.notifications.length ? <ul className="mt-4 divide-y divide-border">{data.notifications.map(n => <li key={n.id} className="min-w-0 py-4 text-sm [overflow-wrap:anywhere]"><div className="flex flex-wrap justify-between gap-2"><span className="text-muted-foreground">{types[n.type] ?? 'Aviso'} · {n.channel === 'email' ? 'Correo' : 'ntfy'}</span><span className={n.status === 'sent' ? 'text-primary' : 'text-destructive'}>{n.status === 'sent' ? 'Enviada' : 'Fallida'}</span></div><p className="mt-2">{n.title}</p><time className="mt-2 block text-xs text-muted-foreground" dateTime={n.sent_at}>{date(n.sent_at)}</time>{n.error && <p className="mt-2 text-destructive">{n.error}</p>}</li>)}</ul> : <p className="mt-3 text-sm text-muted-foreground">Aún no hay notificaciones. Prueba los canales para comprobar la entrega.</p>}
        <div className="mt-5 flex flex-wrap items-center gap-3"><Button variant="outline" disabled={disabled || page === 0} onClick={() => setPage(value => value - 1)}>Anterior</Button><span className="text-xs text-muted-foreground">Página {page + 1}</span><Button variant="outline" disabled={disabled || !data.has_more} onClick={() => setPage(value => value + 1)}>Siguiente</Button></div>
      </section>
    </div>}
    <Button variant="outline" className="mt-5" disabled={disabled} onClick={() => setRefresh(value => value + 1)}>{error ? 'Reintentar consulta' : 'Actualizar ajustes'}</Button>
  </section>;
}
