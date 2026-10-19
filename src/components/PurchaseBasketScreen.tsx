import { useEffect, useRef, useState } from 'react';
import { publication, readPurchases, savePurchases, type Configuration, type PurchaseRead } from '../lib/purchases';
import { requestProducts, type ProductSummary } from '../lib/products';
import { BasketDetailScreen } from './BasketDetailScreen';
import { PurchaseEditor } from './PurchaseEditor';
import { PurchaseResults } from './PurchaseResults';
import { Button } from './ui/button';
import { PurchaseActivation } from './PurchaseActivation';
import { AddProduct } from './AddProduct';

export function PurchaseBasketScreen({ id, name = 'Tu canasta', onDirtyChange, onBusyChange, onBack, onExpired }: { id: string; name?: string; onDirtyChange?: (dirty: boolean) => void; onBusyChange?: (busy: boolean) => void; onBack: () => void; onExpired: (message: string) => void }) {
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
  const [editing, setEditing] = useState(false);
  const [addingProduct, setAddingProduct] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [showActivation, setShowActivation] = useState(false);
  const [comparisonNeedIds, setComparisonNeedIds] = useState<string[]>([]);
  const [activationDirty, setActivationDirty] = useState(false);
  const [activationBusy, setActivationBusy] = useState(false);
  const dirty = activationDirty || !!draft && !!data?.configuration && JSON.stringify(draft) !== JSON.stringify(publication(data.configuration));
  useEffect(() => {
    onDirtyChange?.(dirty);
    const prevent = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    if (dirty) window.addEventListener('beforeunload', prevent);
    return () => { onDirtyChange?.(false); window.removeEventListener('beforeunload', prevent); };
  }, [dirty, onDirtyChange]);
  useEffect(() => { onBusyChange?.(busy || activationBusy); return () => onBusyChange?.(false); }, [busy, activationBusy, onBusyChange]);
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
    setLocked(false); setNeedsConsult(false); setError(''); setNotice(''); setEditing(false); setAddingProduct(false); setShowHistory(false); setComparisonNeedIds([]);
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
        setNotice(d.version === base ? 'Resultado actualizado. Tus cambios sin guardar se conservan.' : 'Nueva versión disponible. El borrador se conserva; carga la versión consultada para editar.');
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
      setEditing(false);
      setNotice('Cambios guardados. El cálculo se actualizará en la próxima revisión automática. Actualizar resultado solo consulta los datos.');
    } catch (e) { if (!controller.signal.aborted) { failure(e); const uncertain = (e as { status?: number }).status !== 400; setLocked(uncertain); setNeedsConsult(uncertain); setData(d => d ? { ...d, latest_evaluation: null, stale_reason: 'uncertain' } : d); } }
    finally { if (operation.current === controller) { operation.current = null; setBusy(false); } }
  }
  const addProductForm = addingProduct ? <AddProduct lists={[]} onExpired={onExpired} onCloseLabel="Volver a mi compra" onClose={() => setAddingProduct(false)} onSaved={() => {
    const controller = new AbortController(); operation.current = controller; setBusy(true);
    void loadProducts(controller.signal).then(() => { if (!controller.signal.aborted) { setAddingProduct(false); setNotice('Producto añadido. Ya puedes elegirlo en las opciones de compra; tu borrador se conserva.'); } }).catch(e => { if (!controller.signal.aborted) { setAddingProduct(false); failure(e); } }).finally(() => { if (operation.current === controller) { operation.current = null; setBusy(false); } });
  }} /> : null;
  if (data?.mode === 'legacy') return <BasketDetailScreen id={id} onBack={onBack} onExpired={onExpired}>
    <section className="mb-5 rounded-xl border border-primary/30 bg-primary/5 p-5" aria-label="Configurar comparación de compra">
      <h2 className="font-medium">¿Quieres comparar formas de cubrir tu compra?</h2>
      <p className="mt-2 mb-4 text-sm text-muted-foreground">Configura necesidades, productos o combos para esta canasta. Revisar la preparación no activa nada; se aplicará solo al confirmar.</p>
      <Button variant="outline" disabled={activationDirty || activationBusy} onClick={() => setShowActivation(v => !v)} aria-expanded={showActivation} aria-controls="purchase-activation">{showActivation ? 'Cerrar configuración' : 'Configurar comparación'}</Button>
      {showActivation && <div id="purchase-activation"><PurchaseActivation key={id} id={id} onDirtyChange={setActivationDirty} onBusyChange={setActivationBusy} onExpired={onExpired} onActivated={() => void consult()} /></div>}
    </section>
  </BasketDetailScreen>;
  return <>{addProductForm}<section hidden={addingProduct} aria-busy={busy} className="mx-auto w-full min-w-0 max-w-3xl space-y-5">
    <Button variant="outline" disabled={busy} onClick={onBack}>← Volver a Canastas</Button>
    <div><h1 className="text-3xl font-semibold">{name}</h1><p className="mt-2 text-sm text-muted-foreground">Tu compra y las opciones para cubrirla.</p></div>
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    <p role="status" className="text-sm text-primary">{busy ? 'Consultando o guardando…' : notice}</p>
    <div className="flex flex-wrap gap-2"><Button variant="outline" disabled={busy} onClick={() => void consult()}>Actualizar resultado</Button>{locked && data?.configuration && <Button variant="outline" disabled={busy || needsConsult} onClick={() => { setDraft(publication(data.configuration!)); setBase(data.version); setLocked(false); setNotice('Versión guardada cargada; borrador anterior descartado.'); }}>Descartar borrador y cargar versión guardada</Button>}</div>
    {data && <PurchaseResults data={data} products={products} onCompare={needIds => { setComparisonNeedIds(needIds); setEditing(true); }} />}
    {draft && <div className="flex flex-wrap gap-2"><Button disabled={busy} onClick={() => setEditing(v => !v)} aria-expanded={editing} aria-controls="purchase-editor">{editing ? 'Cerrar editor' : 'Editar mi compra'}</Button><Button variant="outline" disabled={busy} onClick={() => setShowHistory(v => !v)} aria-expanded={showHistory}>{showHistory ? 'Cerrar historial' : 'Ver historial de la canasta'}</Button></div>}
    {dirty && <p role="status" className="text-sm text-primary">Tienes cambios sin guardar. El resultado corresponde a la última configuración guardada.</p>}
    {showHistory && <BasketDetailScreen id={id} historyOnly onBack={() => setShowHistory(false)} onExpired={onExpired} />}
    {draft && <form id="purchase-editor" hidden={!editing} className="space-y-5 rounded-2xl border border-border bg-card p-4 sm:p-6" onSubmit={e => { e.preventDefault(); void save(); }}>
      <PurchaseEditor value={draft} products={products} onChange={setDraft} disabled={busy || locked} onAddProduct={() => setAddingProduct(true)} comparisonNeedIds={comparisonNeedIds} onComparisonDone={() => setComparisonNeedIds([])} />
      {locked && <p className="text-sm text-destructive">Guardado bloqueado. Consulta el estado antes de continuar.</p>}
      <Button type="submit" disabled={busy || locked}>Guardar cambios</Button>
    </form>}
    {data && <details className="space-y-3 rounded-2xl border border-border p-4 [overflow-wrap:anywhere]"><summary className="cursor-pointer py-2 text-lg font-medium">Actividad y avisos</summary><div className="space-y-3"><h2 className="text-base font-medium">Avisos y recibos por canal</h2><p className="text-xs text-muted-foreground">Historial de entregas; consultar no reenvía avisos. Un resultado ambiguo no confirma recepción.</p>{!data.events.length && <p className="text-sm">Sin avisos registrados.</p>}
      {data.events.map(e => <article key={e.id} className="space-y-2 border-t border-border pt-3"><h3 className="text-sm">Versión {e.version} · {e.reasons === 'budget' ? 'Presupuesto' : e.reasons === 'winner' ? 'Cambio de ganador' : 'Presupuesto y cambio de ganador'} · {deliveryStatus(e.status)}</h3>{e.deliveries.map(d => <div key={d.channel} className="text-sm"><p>{d.channel === 'email' ? 'Correo' : d.channel}: {deliveryStatus(d.status)}</p><details><summary className="cursor-pointer py-3">Ver recibo de {d.channel}</summary><pre className="whitespace-pre-wrap break-all text-xs">{d.receipt === null ? 'Sin recibo' : JSON.stringify(d.receipt, null, 2)}</pre></details></div>)}</article>)}
      {data.has_more && <Button variant="outline" disabled={busy} onClick={() => void consult(true)}>Cargar más recibos</Button>}
    </div></details>}
    {data && <details className="text-sm text-muted-foreground"><summary className="cursor-pointer py-3">Detalles de configuración</summary><p>Versión guardada {data.version} · borrador basado en {base}</p></details>}
  </section></>;
}
function deliveryStatus(value: string) { return ({ sent: 'Enviado', delivered: 'Entregado', failed: 'Fallido', ambiguous: 'Entrega incierta', pending: 'Pendiente', claimed: 'En proceso', completed: 'Completado', partial: 'Entrega parcial' } as Record<string, string>)[value] ?? value; }
