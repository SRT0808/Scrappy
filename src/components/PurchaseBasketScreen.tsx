import { useEffect, useRef, useState } from 'react';
import { publication, readPurchases, savePurchases, type Configuration, type PurchaseRead } from '../lib/purchases';
import { requestProducts, type ProductSummary } from '../lib/products';
import { BasketDetailScreen } from './BasketDetailScreen';
import { PurchaseEditor } from './PurchaseEditor';
import { PurchaseResults } from './PurchaseResults';
import { Button } from './ui/button';

export function PurchaseBasketScreen({ id, onBack, onExpired }: { id: string; onBack: () => void; onExpired: (message: string) => void }) {
  const [data, setData] = useState<PurchaseRead | null>(null);
  const [draft, setDraft] = useState<Configuration | null>(null);
  const [base, setBase] = useState('');
  const [products, setProducts] = useState<ProductSummary[]>([]);
  const [busy, setBusy] = useState(true);
  const [locked, setLocked] = useState(false);
  const [needsConsult, setNeedsConsult] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [page, setPage] = useState(0);
  const operation = useRef<AbortController | null>(null);
  const expired = useRef(onExpired); expired.current = onExpired;
  function failure(e: unknown) { const p = e as { status?: number; message?: string }; if (p.status === 401) expired.current(p.message ?? 'Tu sesión ha caducado.'); else setError(p.message ?? 'No pudimos consultar el estado.'); }
  async function loadProducts(signal: AbortSignal) {
    const p = await requestProducts('', signal);
    if (!signal.aborted) setProducts(p);
  }
  useEffect(() => {
    const controller = new AbortController();
    operation.current = controller;
    setBusy(true); setData(null); setDraft(null); setBase(''); setProducts([]); setPage(0);
    setLocked(false); setNeedsConsult(false); setError(''); setNotice('');
    readPurchases(id, 0, controller.signal).then(async d => {
      if (controller.signal.aborted) return;
      setData(d); setBase(d.version); setDraft(d.configuration ? publication(d.configuration) : null);
      if (d.mode === 'alternatives') await loadProducts(controller.signal);
    }).catch(e => { if (!controller.signal.aborted) failure(e); }).finally(() => {
      if (operation.current === controller) { operation.current = null; setBusy(false); }
    });
    return () => { operation.current?.abort(); operation.current = null; };
  }, [id]);
  async function consult(more = false) {
    if (operation.current) return;
    const controller = new AbortController(); operation.current = controller;
    setBusy(true); setError(''); setNotice('');
    setData(d => d ? { ...d, latest_evaluation: null, stale_reason: 'uncertain' } : d);
    try {
      const d = await readPurchases(id, more ? page + 1 : 0, controller.signal);
      if (controller.signal.aborted) return;
      if (!more && d.mode === 'alternatives') await loadProducts(controller.signal);
      if (controller.signal.aborted) return;
      if (more) {
        if (d.version !== data?.version) { setLocked(true); setNeedsConsult(true); setError('La versión cambió. Consulta el estado antes de seguir.'); return; }
        setData({ ...d, events: [...data.events, ...d.events.filter(e => !data.events.some(old => old.id === e.id))] }); setPage(p => p + 1);
      } else {
        setData(d); setPage(0); setNeedsConsult(false); setLocked(d.version !== base);
        if (!draft) { setBase(d.version); setDraft(d.configuration ? publication(d.configuration) : null); setLocked(false); }
        setNotice(d.version === base ? 'Estado consultado. Revisa el borrador antes de guardar.' : 'Nueva versión disponible. El borrador se conserva; carga la versión consultada para editar.');
      }
    } catch (e) { if (!controller.signal.aborted) failure(e); }
    finally { if (operation.current === controller) { operation.current = null; setBusy(false); } }
  }
  async function save() {
    if (!draft || !data || locked || operation.current) return;
    const controller = new AbortController(); operation.current = controller;
    setBusy(true); setError(''); setNotice('');
    try {
      await savePurchases(id, base, draft);
      if (controller.signal.aborted) return;
      const d = await readPurchases(id, 0, controller.signal);
      if (controller.signal.aborted) return;
      setData(d); setBase(d.version); setDraft(d.configuration ? publication(d.configuration) : null); setPage(0);
      setNotice('Configuración guardada. Recálculo pendiente; no se ha activado la operación.');
    } catch (e) { if (!controller.signal.aborted) { failure(e); setLocked(true); setNeedsConsult(true); setData(d => d ? { ...d, latest_evaluation: null, stale_reason: 'uncertain' } : d); } }
    finally { if (operation.current === controller) { operation.current = null; setBusy(false); } }
  }
  if (data?.mode === 'legacy') return <BasketDetailScreen id={id} onBack={onBack} onExpired={onExpired} />;
  return <section aria-busy={busy} className="mx-auto w-full min-w-0 max-w-3xl space-y-5">
    <Button variant="outline" disabled={busy} onClick={onBack}>← Volver a Canastas</Button>
    <div><h1 className="text-3xl font-semibold">Necesidades y alternativas</h1><p className="mt-2 text-sm text-muted-foreground">{data ? `Versión consultada ${data.version} · borrador basado en ${base}` : 'Cargando alternativas…'}</p></div>
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    <p role="status" className="text-sm text-primary">{busy ? 'Consultando o guardando…' : notice}</p>
    <div className="flex flex-wrap gap-2"><Button variant="outline" disabled={busy} onClick={() => void consult()}>Consultar estado</Button>{data?.configuration && <Button variant="outline" disabled={busy || needsConsult} onClick={() => { setDraft(publication(data.configuration!)); setBase(data.version); setLocked(false); setNotice('Versión consultada cargada; borrador anterior descartado.'); }}>Descartar borrador y cargar versión consultada</Button>}</div>
    {data && <PurchaseResults data={data} products={products} />}
    {draft && <form className="space-y-5 rounded-2xl border border-border bg-card p-4 sm:p-6" onSubmit={e => { e.preventDefault(); void save(); }}>
      <PurchaseEditor value={draft} products={products} onChange={setDraft} disabled={busy || locked} />
      {locked && <p className="text-sm text-destructive">Guardado bloqueado. Consulta el estado antes de continuar.</p>}
      <Button type="submit" disabled={busy || locked}>Guardar configuración</Button>
    </form>}
    {data && <section className="space-y-3 rounded-2xl border border-border p-4 [overflow-wrap:anywhere]"><h2 className="text-lg font-medium">Avisos y recibos por canal</h2><p className="text-xs text-muted-foreground">Historial de entregas; consultar no reenvía avisos. Un resultado ambiguo no confirma recepción.</p>{!data.events.length && <p className="text-sm">Sin avisos registrados.</p>}
      {data.events.map(e => <article key={e.id} className="space-y-2 border-t border-border pt-3"><h3 className="text-sm">Versión {e.version} · {e.reasons === 'budget' ? 'Presupuesto' : e.reasons === 'winner' ? 'Cambio de ganador' : 'Presupuesto y cambio de ganador'} · {deliveryStatus(e.status)}</h3>{e.deliveries.map(d => <div key={d.channel} className="text-sm"><p>{d.channel === 'email' ? 'Correo' : d.channel}: {deliveryStatus(d.status)}</p><details><summary className="cursor-pointer py-3">Ver recibo de {d.channel}</summary><pre className="whitespace-pre-wrap break-all text-xs">{d.receipt === null ? 'Sin recibo' : JSON.stringify(d.receipt, null, 2)}</pre></details></div>)}</article>)}
      {data.has_more && <Button variant="outline" disabled={busy} onClick={() => void consult(true)}>Cargar más recibos</Button>}
    </section>}
  </section>;
}
function deliveryStatus(value: string) { return ({ sent: 'Enviado', delivered: 'Entregado', failed: 'Fallido', ambiguous: 'Entrega incierta', pending: 'Pendiente', claimed: 'En proceso', completed: 'Completado', partial: 'Entrega parcial' } as Record<string, string>)[value] ?? value; }
