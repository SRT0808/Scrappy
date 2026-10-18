import { useEffect, useRef, useState } from 'react';
import { activationRequest, publication, type ActivationPreview, type Configuration } from '../lib/purchases';
import { Button } from './ui/button';
import { PurchaseEditor } from './PurchaseEditor';
import { requestProducts, type ProductSummary } from '../lib/products';

export function PurchaseActivation({ id, onActivated, onExpired, onDirtyChange, onBusyChange }: {
  id: string; onActivated: () => void; onExpired: (message: string) => void;
  onDirtyChange?: (dirty: boolean) => void; onBusyChange?: (busy: boolean) => void;
}) {
  const key = `scrappy.activation.${id}`;
  const [pending, setPending] = useState(() => sessionStorage.getItem(key) ?? '');
  const [preview, setPreview] = useState<ActivationPreview | null>(null);
  const [draft, setDraft] = useState<Configuration | null>(null);
  const [products, setProducts] = useState<ProductSummary[]>([]);
  const [budget, setBudget] = useState('');
  const [winner, setWinner] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const dirty = !!pending || !!preview && (!!budget || !!winner || confirmed || JSON.stringify(draft) !== JSON.stringify(publication(preview.configuration)));
  useEffect(() => { onDirtyChange?.(dirty); return () => onDirtyChange?.(false); }, [dirty, onDirtyChange]);
  useEffect(() => { onBusyChange?.(busy); return () => onBusyChange?.(false); }, [busy, onBusyChange]);
  const active = useRef(true), inFlight = useRef(false);
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  function failure(e: unknown) {
    const error = e as { status?: number; message?: string };
    if (error.status === 401) onExpired(error.message ?? 'Tu sesión ha caducado.');
    else setMessage(error.message ?? 'No pudimos consultar el estado.');
  }
  async function run(work: () => Promise<void>) {
    if (inFlight.current) return;
    inFlight.current = true; setBusy(true); setMessage('');
    try { await work(); } catch (e) { if (active.current) failure(e); }
    finally { inFlight.current = false; if (active.current) setBusy(false); }
  }
  async function prepare() {
    await run(async () => {
      const p = await activationRequest(id, '?preview=1') as ActivationPreview;
      if (!active.current) return;
      if (!/^[1-9]\d{0,18}$/.test(p.version) || !/^[a-f0-9]{64}$/.test(p.token)) throw new Error('Invalid preview');
      const c = publication(p.configuration);
      const catalog = c.needs.length ? [] : await requestProducts('');
      if (!active.current) return;
      setPreview(p); setDraft(c); setProducts(catalog); setBudget(''); setWinner(''); setConfirmed(false);
    });
  }
  async function consult() {
    await run(async () => {
      const r = await activationRequest(id, `?request_id=${encodeURIComponent(pending)}`);
      if (!active.current) return;
      if (r.request_id !== pending || !Object.hasOwn(r, 'receipt')) throw new Error('Invalid receipt');
      if (r.receipt) {
        const receipt = r.receipt as { request_id?: string; list_id?: string; version?: string };
        if (receipt.request_id !== pending || receipt.list_id !== id || !/^[1-9]\d{0,18}$/.test(receipt.version ?? '')) throw new Error('Invalid receipt');
        sessionStorage.removeItem(key); onActivated();
      } else {
        setMessage('Todavía no hay recibo para esta solicitud. Puedes consultar de nuevo o preparar una confirmación actualizada.');
        setPending(''); setPreview(null); setDraft(null);
      }
    });
  }
  async function activate() {
    if (!preview || !draft || !confirmed || !budget || !winner || pending) return;
    await run(async () => {
      const request_id = crypto.randomUUID();
      sessionStorage.setItem(key, request_id); setPending(request_id);
      const r = await activationRequest(id, '', { schema_version: 2, request_id, expected_version: preview.version,
        token: preview.token, configuration: { ...publication(draft), budget_enabled: budget === 'yes', winner_enabled: winner === 'yes' } });
      if (!active.current) return;
      if (r.request_id !== request_id || r.previous_version !== preview.version
        || r.version !== (BigInt(preview.version) + 1n).toString()) throw new Error('Invalid activation response');
      sessionStorage.removeItem(key); onActivated();
    });
  }
  return <section aria-label="Activación de alternativas" aria-busy={busy} className="mx-auto my-5 w-full min-w-0 max-w-3xl space-y-4 rounded-2xl border border-border bg-card p-4 [overflow-wrap:anywhere] sm:p-6">
    <h2 className="text-xl font-semibold">Activar necesidades y alternativas</h2>
    <p className="text-sm text-muted-foreground">La conversión conserva productos, cantidades, referencias e historial. Se aplicará solo a esta canasta. La recuperación conserva sus versiones; no vuelve al modo anterior.</p>
    {message && <p role="status" className="text-sm text-primary">{message}</p>}
    {pending ? <><p>Hay una solicitud sin conciliar. Consulta su recibo antes de continuar.</p><Button disabled={busy} onClick={() => void consult()}>Consultar recibo de activación</Button></>
      : <Button variant="outline" disabled={busy} onClick={() => void prepare()}>Preparar conversión</Button>}
    {preview && draft && !pending && <form className="space-y-4" onSubmit={e => { e.preventDefault(); void activate(); }}>
      <p>Versión {preview.version} → {(BigInt(preview.version) + 1n).toString()} · {draft.currency} · presupuesto {draft.budget ?? 'sin meta'}</p>
      {preview.configuration.needs.length ? <ol className="space-y-2 text-sm">{draft.needs.map(n => <li key={n.id}>{n.name}: {n.required_quantity} unidades · una necesidad, oferta y alternativa conservadas</li>)}</ol>
        : <><p>Canasta vacía: configura y confirma un conjunto válido de necesidades y alternativas.</p><PurchaseEditor value={draft} onChange={c => { setDraft(c); setConfirmed(false); }} products={products} disabled={busy} /></>}
      <p className="text-sm text-muted-foreground">El primer cálculo que cumpla el presupuesto puede enviar avisos. El primer ganador establece la base sin aviso de cambio. El umbral de cambio es {draft.minimum_savings} {draft.currency}.</p>
      <fieldset disabled={busy} className="space-y-3">
        <legend className="mb-2 font-medium">Elige los avisos expresamente</legend>
        {([['Avisar presupuesto', budget, setBudget], ['Avisar cambio de ganador', winner, setWinner]] as const).map(([label, value, change]) => <label key={label} className="block text-sm">{label}<select className="mt-2 h-12 w-full rounded-lg border border-input bg-card px-3" value={value} onChange={e => { change(e.target.value); setConfirmed(false); }}><option value="">Elige una opción</option><option value="no">Desactivado</option><option value="yes">Activado</option></select></label>)}
        <label className="flex min-h-11 items-center gap-3 text-sm"><input type="checkbox" checked={confirmed} onChange={e => setConfirmed(e.target.checked)} />Confirmo esta conversión y los avisos seleccionados</label>
      </fieldset>
      <Button disabled={busy || !confirmed || !budget || !winner}>Confirmar activación de esta canasta</Button>
      <Button type="button" variant="outline" disabled={busy} onClick={() => { setPreview(null); setDraft(null); setBudget(''); setWinner(''); setConfirmed(false); }}>Descartar preparación</Button>
    </form>}
  </section>;
}
