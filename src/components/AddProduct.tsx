import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { loadDefaultInterval } from '../lib/settings';
import { ListsError, requestLists, type List } from '../lib/lists';
import { money, percentageTarget, productUrl, ProductsError, requestReading, validConfirmation, type Reading, type Confirmation } from '../lib/products';

type Props = { lists: List[]; onClose: () => void; onSaved: (id: string, listId: string) => void; onExpired: (message: string) => void };
const selectClass = 'h-12 w-full min-w-0 rounded-lg border border-input bg-background px-3 text-sm focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-50';
const currencies = ['PEN', 'USD', 'EUR', 'GBP', 'CAD', 'AUD', 'CLP', 'COP', 'MXN', 'ARS', 'BRL', 'JPY', 'CHF'];

export function AddProduct({ lists: initialLists, onClose, onSaved, onExpired }: Props) {
  const [lists, setLists] = useState(initialLists);
  const [url, setUrl] = useState('');
  const [selector, setSelector] = useState('');
  const [reading, setReading] = useState<Reading | null>(null);
  const [requestId, setRequestId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [waiting, setWaiting] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const [error, setError] = useState('');
  const [name, setName] = useState('');
  const [currency, setCurrency] = useState('');
  const [reference, setReference] = useState('');
  const [listId, setListId] = useState(initialLists[0]?.id ?? '');
  const [candidate, setCandidate] = useState<number | null>(null);
  const [targetType, setTargetType] = useState<'price' | 'percent'>('price');
  const [target, setTarget] = useState('');
  const [interval, setInterval] = useState(6);
  const [confirmed, setConfirmed] = useState(false);
  const [pollRun, setPollRun] = useState(0);
  const active = useRef<AbortController | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const resultTitle = useRef<HTMLHeadingElement>(null);
  const lastRequest = useRef<{ action: 'read'; url: string; selector?: string } | null>(null);
  const applied = useRef<string | null>(null);
  const expired = useRef(onExpired);
  const saved = useRef(onSaved);
  expired.current = onExpired;
  saved.current = onSaved;
  const pending = reading?.status === 'queued' || reading?.status === 'reading';
  const result = reading?.result;
  const chosen = candidate === null ? result : result?.candidates[candidate];
  const chosenPrice = chosen?.price ?? null;
  const ambiguous = !!result && result.confidence < 0.8 && result.candidates.length > 0;
  const canConfirm = reading?.status === 'ready' && !!chosenPrice && (!ambiguous || candidate !== null);
  const equivalent = money(reference) && money(target, targetType === 'price') && (targetType === 'price' || Number(target) <= 100)
    ? targetType === 'price' ? `${((1 - Number(target) / Number(reference)) * 100).toFixed(2)} % de descuento`
      : `${percentageTarget(reference, target)} ${currency || '—'}` : 'Completa la referencia y la condición.';

  useEffect(() => { input.current?.focus(); return () => { active.current?.abort(); }; }, []);

  function accept(row: Reading) {
    setReading(row);
    setUncertain(false);
    if (row.status === 'confirmed' && row.product_id) { saved.current(row.product_id, listId); return; }
    if (row.result && applied.current !== row.id) {
      applied.current = row.id;
      setName(row.result.name ?? '');
      setCurrency(row.result.currency ?? '');
      setReference(row.result.original_price ?? row.result.price ?? '');
      setCandidate(null);
      setConfirmed(false);
      setTarget('');
      setTimeout(() => resultTitle.current?.focus(), 0);
    }
  }

  function failure(problem: ProductsError | ListsError) {
    if (problem.status === 401) expired.current(problem.message);
    else { setError(problem.message); setUncertain(true); }
  }

  // Sequential polling: each request finishes before scheduling the next one.
  useEffect(() => {
    if (!pending || !requestId || uncertain) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const started = Date.now();
    setWaiting(true);
    async function poll() {
      try {
        const row = await requestReading(requestId!, undefined, controller.signal);
        if (controller.signal.aborted) return;
        accept(row);
        if (row.status === 'queued' || row.status === 'reading') {
          if (Date.now() - started >= 300_000) {
            setWaiting(false); setError('La lectura tarda más de lo habitual. Consulta su estado en un momento.');
          } else timer = setTimeout(() => void poll(), 3000);
        } else setWaiting(false);
      } catch (problem) {
        if (!controller.signal.aborted) { setWaiting(false); failure(problem as ProductsError); }
      }
    }
    timer = setTimeout(() => void poll(), 1000);
    return () => { controller.abort(); clearTimeout(timer); };
  }, [pending, requestId, uncertain, pollRun]);

  async function run(body?: Parameters<typeof requestReading>[1], id = requestId) {
    if (active.current || !id) return;
    const controller = new AbortController();
    active.current = controller;
    setBusy(true); setError('');
    try {
      if (body?.action === 'read' && applied.current === null) {
        const defaultHours = await loadDefaultInterval(controller.signal);
        if (controller.signal.aborted) return;
        setInterval(defaultHours);
      }
      const row = await requestReading(id, body, controller.signal);
      if (!controller.signal.aborted) { accept(row); setPollRun(value => value + 1); }
    } catch (problem) {
      if (!controller.signal.aborted) failure(problem as ProductsError);
    } finally {
      if (!controller.signal.aborted) { active.current = null; setBusy(false); }
    }
  }

  function start(event: FormEvent, withSelector = false) {
    event.preventDefault();
    if (active.current || waiting) return;
    const normalized = productUrl(url);
    if (!normalized || (withSelector && (!selector.trim() || selector.length > 500))) {
      setError('Introduce una URL HTTP(S) pública y un selector de hasta 500 caracteres.'); return;
    }
    const id = crypto.randomUUID();
    const body = { action: 'read' as const, url: normalized, ...(withSelector ? { selector: selector.trim() } : {}) };
    lastRequest.current = body;
    setRequestId(id); setReading(null); setConfirmed(false); setUncertain(false); setWaiting(false);
    void run(body, id);
  }

  function choose(index: number) {
    setCandidate(index);
    const choice = result!.candidates[index];
    setCurrency(choice.currency ?? '');
    setReference(result!.original_price ?? choice.price);
    if (choice.name) setName(choice.name);
    setConfirmed(false);
  }

  function save(event: FormEvent) {
    event.preventDefault();
    if (active.current || waiting || uncertain || !canConfirm) return;
    const body: Confirmation = { list_id: listId, name: name.trim(), currency, candidate_index: candidate,
      reference_price: reference, target_type: targetType, target_value: target, check_interval_hours: interval };
    if (!confirmed || !validConfirmation(body)) {
      setError('Confirma el precio y la moneda, elige una lista y revisa la referencia y la condición.'); return;
    }
    void run({ action: 'confirm', ...body });
  }

  async function refreshLists() {
    if (active.current) return;
    const controller = new AbortController(); active.current = controller; setBusy(true); setError('');
    try {
      const rows = await requestLists('read', undefined, undefined, controller.signal);
      if (!controller.signal.aborted) { setLists(rows); if (!rows.some(row => row.id === listId)) setListId(rows[0]?.id ?? ''); }
    } catch (problem) { if (!controller.signal.aborted) failure(problem as ListsError); }
    finally { if (!controller.signal.aborted) { active.current = null; setBusy(false); } }
  }

  const locked = busy || waiting;
  return <section aria-labelledby="add-title" className="mx-auto w-full max-w-2xl self-start">
    <div className="mb-6 flex flex-wrap items-start justify-between gap-3"><div><p className="mb-2 text-xs tracking-[0.16em] text-primary uppercase">Tu próxima oferta</p><h1 id="add-title" className="text-3xl font-semibold">Añadir producto</h1></div><Button variant="outline" disabled={busy} onClick={onClose}>Volver a listas</Button></div>
    <p className="mb-6 text-sm text-muted-foreground">1. Leer la tienda · 2. Confirmar el precio · 3. Definir tu meta</p>
    <form onSubmit={event => start(event)} className="space-y-3 rounded-2xl border border-border bg-card p-5 sm:p-6">
      <label htmlFor="product-url" className="text-sm font-medium">URL del producto</label>
      <Input ref={input} id="product-url" type="url" inputMode="url" required value={url} disabled={locked || !!requestId} onChange={event => setUrl(event.target.value)} placeholder="https://tienda.com/producto" />
      {!requestId && <Button type="submit" disabled={locked} className="w-full sm:w-auto">Leer producto</Button>}
      {requestId && <div className="flex flex-wrap gap-2"><Button type="button" variant="outline" disabled={locked} onClick={() => void run()}>Consultar lectura</Button>
        <Button type="button" variant="outline" disabled={locked} onClick={() => { setRequestId(null); setReading(null); setUncertain(false); setError(''); }}>Cambiar URL</Button>
        {uncertain && lastRequest.current && <Button type="button" variant="outline" disabled={locked} onClick={() => void run(lastRequest.current!)}>Reintentar lectura</Button>}
      </div>}
    </form>
    {error && <p role="alert" className="mt-4 text-sm leading-relaxed text-destructive">{error}</p>}
    {locked && <div role="status" className="mt-5 rounded-2xl border border-border bg-card p-5"><p className="text-sm text-primary">{waiting ? 'Leyendo la tienda… Puede tardar unos minutos.' : 'Procesando tu solicitud…'}</p><div aria-hidden="true" className="mt-4 h-20 rounded-lg bg-muted motion-safe:animate-pulse" /></div>}
    {result && <div className="mt-6 space-y-5">
      <section aria-labelledby="reading-title" className="rounded-2xl border border-border bg-card p-5 sm:p-6">
        <h2 id="reading-title" ref={resultTitle} tabIndex={-1} className="mb-4 text-lg font-semibold">Confirma lo que encontramos</h2>
        <div className="flex min-w-0 gap-4">{result.image_url && /^https?:\/\//i.test(result.image_url) && <img src={result.image_url} alt="" referrerPolicy="no-referrer" className="size-20 shrink-0 rounded-lg bg-muted object-contain" onError={event => { event.currentTarget.hidden = true; }} />}
          <div className="min-w-0"><p className="break-words font-medium">{result.name || 'Producto sin nombre'}</p><p className="mt-2 text-xl font-semibold text-primary tabular-nums">{chosenPrice ? `${chosenPrice} ${currency || 'Moneda por confirmar'}` : 'Precio sin leer'}</p><p className="mt-2 text-xs text-muted-foreground">Método: {({ json_ld: 'Datos estructurados', meta_microdata: 'Metadatos', heuristic: 'Precio visible', recipe: 'Selector CSS', adaptive: 'Selector recuperado', none: 'Sin resultado' } as Record<string, string>)[result.method] ?? result.method} · Confianza: {Math.round(result.confidence * 100)} %</p></div>
        </div>
        {result.warnings.length > 0 && <ul className="mt-4 space-y-1 text-sm text-muted-foreground">{result.warnings.map((warning, index) => <li key={index} className="break-words">{warning}</li>)}</ul>}
        {result.candidates.length > 0 && <fieldset className="mt-5 min-w-0 space-y-2"><legend className="mb-3 text-sm font-medium">{ambiguous ? 'Elige el precio correcto para continuar' : 'Otros precios detectados'}</legend>{result.candidates.map((choice, index) => <label key={index} className="flex min-w-0 cursor-pointer items-start gap-3 rounded-lg border border-border p-3 text-sm"><input type="radio" name="candidate" checked={candidate === index} disabled={locked || uncertain} onChange={() => choose(index)} className="mt-1 shrink-0 accent-emerald-500" /><span className="min-w-0 break-words"><span className="font-medium tabular-nums">{choice.price} {choice.currency || 'Moneda por confirmar'}</span><span className="mt-1 block text-muted-foreground">{choice.context}</span></span></label>)}</fieldset>}
      </section>
      <form onSubmit={event => start(event, true)} className="space-y-3 rounded-2xl border border-border bg-card p-5">
        <label htmlFor="price-selector" className="text-sm font-medium">Enseñar un selector CSS</label><p className="text-xs text-muted-foreground">Si el precio falta o es incorrecto, indica el selector y vuelve a leer la tienda.</p><Input id="price-selector" value={selector} disabled={locked} onChange={event => setSelector(event.target.value)} placeholder=".precio-final" maxLength={500} /><Button type="submit" variant="outline" disabled={locked || uncertain}>Leer con selector</Button>
      </form>
      {reading?.status === 'ready' && <form onSubmit={save} className="space-y-5 rounded-2xl border border-border bg-card p-5 sm:p-6">
        <h2 className="text-lg font-semibold">Define tu meta</h2>
        <fieldset disabled={locked || uncertain} className="space-y-5">
          <div className="space-y-2"><label htmlFor="product-name" className="text-sm font-medium">Nombre del producto</label><Input id="product-name" value={name} onChange={event => setName(event.target.value)} required /></div>
          <div className="grid gap-4 sm:grid-cols-2"><div className="space-y-2"><label htmlFor="product-currency" className="text-sm font-medium">Moneda</label><select id="product-currency" className={selectClass} value={currency} disabled={!!chosen?.currency} onChange={event => { setCurrency(event.target.value); setConfirmed(false); }} required><option value="">Elige la moneda</option>{[...new Set([...currencies, ...(currency ? [currency] : [])])].map(code => <option key={code}>{code}</option>)}</select></div>
          <div className="space-y-2"><label htmlFor="reference-price" className="text-sm font-medium">Precio de referencia</label><Input id="reference-price" inputMode="decimal" value={reference} onChange={event => setReference(event.target.value)} required /><p className="text-xs text-muted-foreground">Precio sin descuento; puedes editarlo.</p></div></div>
          <div className="space-y-2"><label htmlFor="product-list" className="text-sm font-medium">Lista</label><select id="product-list" className={selectClass} value={listId} onChange={event => setListId(event.target.value)} required><option value="">Elige una lista</option>{lists.map(list => <option key={list.id} value={list.id}>{list.name}</option>)}</select>{lists.length === 0 && <p className="text-sm text-muted-foreground">Crea una lista antes de guardar el producto.</p>}<Button type="button" variant="outline" onClick={() => void refreshLists()}>Actualizar listas disponibles</Button></div>
          <div className="grid gap-4 sm:grid-cols-2"><div className="space-y-2"><label htmlFor="target-type" className="text-sm font-medium">Condición</label><select id="target-type" className={selectClass} value={targetType} onChange={event => { setTargetType(event.target.value as 'price' | 'percent'); setTarget(''); }}><option value="price">Precio objetivo</option><option value="percent">Porcentaje de descuento</option></select></div><div className="space-y-2"><label htmlFor="target-value" className="text-sm font-medium">{targetType === 'price' ? 'Precio objetivo' : 'Descuento (%)'}</label><Input id="target-value" inputMode="decimal" value={target} onChange={event => setTarget(event.target.value)} required /></div></div>
          <p aria-live="polite" className="text-sm text-primary tabular-nums">Equivalente: {equivalent}</p>
          <div className="space-y-2"><label htmlFor="check-interval" className="text-sm font-medium">Intervalo de revisión</label><select id="check-interval" className={selectClass} value={interval} onChange={event => setInterval(Number(event.target.value))}>{[3, 6, 12, 24].map(hours => <option key={hours} value={hours}>Cada {hours} horas</option>)}</select></div>
          <label className="flex items-start gap-3 text-sm"><input type="checkbox" checked={confirmed} onChange={event => setConfirmed(event.target.checked)} className="mt-1 shrink-0 accent-emerald-500" /><span>Confirmo el precio y la moneda del producto.</span></label>
          <Button type="submit" className="w-full" disabled={!canConfirm || !confirmed || !lists.length}>Guardar producto</Button>
        </fieldset>
      </form>}
    </div>}
  </section>;
}
