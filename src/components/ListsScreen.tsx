import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { ListsError, requestLists, type List, type ListAction, type ListBody } from '../lib/lists';
import { parseBudget } from '../lib/baskets';
import { BasketSummary } from './BasketSummary';

type Props = { onExpired: (message: string) => void; onLogout: () => void; sessionBusy: boolean; sessionError: string; onHome?: () => void; showLogout?: boolean; onDetail?: (id: string) => void };

export function ListsScreen({ onExpired, onLogout, sessionBusy, sessionError, onHome, showLogout = true, onDetail }: Props) {
  const [lists, setLists] = useState<List[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [name, setName] = useState('');
  const [editing, setEditing] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [needsRefresh, setNeedsRefresh] = useState(false);
  const [basketId, setBasketId] = useState<string | null>(null);
  const [budget, setBudget] = useState('');
  const [currency, setCurrency] = useState('PEN');
  const active = useRef<AbortController | null>(null);
  const field = useRef<HTMLInputElement>(null);
  const locked = busy || sessionBusy;
  const mutationLocked = locked || needsRefresh;

  async function run(action: ListAction, body?: ListBody, id?: string) {
    if (active.current || sessionBusy || (action !== 'read' && needsRefresh)) return;
    const controller = new AbortController();
    active.current = controller;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const rows = await requestLists(action, body, id, controller.signal);
      if (controller.signal.aborted) return;
      setLists(current => action === 'create' ? [...current, ...rows]
        : action === 'rename' || action === 'basket' ? current.map(row => row.id === id ? { ...row, ...rows[0] } : row)
        : action === 'delete' ? current.filter(row => row.id !== id) : rows);
      setLoaded(true);
      setNeedsRefresh(false);
      setName('');
      setEditing(null);
      setDeleting(null);
      setBasketId(null);
      if (action !== 'read') setNotice('Cambio guardado.');
    } catch (failure) {
      if (controller.signal.aborted) return;
      const problem = failure as ListsError;
      if (problem.status === 401) onExpired(problem.message);
      else {
        setError(problem.message);
        if (problem.status === 0 || problem.status === 404 || (problem.status === 409 && action === 'reorder')) setNeedsRefresh(true);
      }
    } finally {
      if (!controller.signal.aborted) { active.current = null; setBusy(false); }
    }
  }

  useEffect(() => {
    void run('read');
    return () => { active.current?.abort(); active.current = null; };
    // The screen is mounted only for an authenticated session.
  }, []);

  function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (mutationLocked) return;
    if (!name.trim() || [...name.trim()].length > 100) {
      setError('Indica un nombre de 1 a 100 caracteres.');
      field.current?.focus();
      return;
    }
    void run(editing ? 'rename' : 'create', { name: name.trim() }, editing ?? undefined);
  }

  function move(index: number, direction: number) {
    const ids = lists.map(row => row.id);
    [ids[index], ids[index + direction]] = [ids[index + direction], ids[index]];
    void run('reorder', { ids });
  }

  return <section aria-labelledby="lists-title" aria-busy={locked} className="mx-auto w-full max-w-2xl self-start">
    <div className="mb-8 flex flex-wrap items-start justify-between gap-4">
      <div><p className="mb-2 text-xs font-medium tracking-[0.16em] text-primary uppercase">Tu radar de precios</p><h1 id="lists-title" className="text-3xl font-semibold tracking-tight">Tus canastas</h1><p className="mt-3 text-sm text-muted-foreground">Combina productos y cantidades sin modificar sus metas individuales.</p></div>
      {showLogout && <Button variant="outline" disabled={locked} onClick={onLogout}>{sessionBusy ? 'Cerrando sesión…' : 'Cerrar sesión'}</Button>}
    </div>
    {onHome && <div className="mb-6"><Button variant="outline" disabled={locked} onClick={onHome}>Volver a Inicio</Button></div>}
    <form onSubmit={save} className="mb-6 rounded-2xl border border-border bg-card p-5 sm:p-6">
      <label htmlFor="list-name" className="text-sm font-medium">{editing ? 'Nuevo nombre' : 'Nombre de la nueva canasta'}</label>
      <div className="mt-3 flex flex-col gap-3 sm:flex-row">
        <Input ref={field} id="list-name" value={name} disabled={mutationLocked || !loaded} onChange={event => setName(event.target.value)} placeholder="Por ejemplo, Tecnología" aria-describedby="list-name-help" />
        <Button type="submit" disabled={mutationLocked || !loaded}>{editing ? 'Guardar nombre' : 'Crear canasta'}</Button>
        {editing && <Button variant="outline" type="button" disabled={locked} onClick={() => { setEditing(null); setName(''); field.current?.focus(); }}>Cancelar</Button>}
      </div>
      <p id="list-name-help" className="mt-3 text-xs text-muted-foreground">Entre 1 y 100 caracteres.</p>
    </form>
    {(error || sessionError) && <p role="alert" className="mb-4 text-sm leading-relaxed text-destructive">{error || sessionError}</p>}
    <p role="status" className="mb-4 text-sm text-primary">{busy ? 'Guardando o cargando canastas…' : notice}</p>
    <div className="mb-4 flex flex-wrap items-center justify-between gap-3"><p className="text-sm text-muted-foreground">{loaded ? `${lists.length} ${lists.length === 1 ? 'canasta' : 'canastas'}` : 'Tus colecciones'}</p><Button variant="outline" disabled={locked} onClick={() => void run('read')}>Actualizar canastas</Button></div>
    {!loaded && busy ? <div aria-hidden="true" className="space-y-3">{[0, 1, 2].map(key => <div key={key} className="h-28 rounded-2xl border border-border bg-card motion-safe:animate-pulse" />)}</div>
      : loaded && lists.length === 0 ? <div className="rounded-2xl border border-dashed border-border p-8 text-center"><h2 className="font-semibold">Tu primera canasta empieza aquí</h2><p className="mt-2 text-sm text-muted-foreground">Crea una canasta y agrega productos de tu catálogo.</p></div>
      : <ol className="space-y-3">{lists.map((list, index) => <li key={list.id} className="rounded-2xl border border-border bg-card p-5">
        <h2 className="mb-4 break-words text-lg font-medium">{list.emoji && <span aria-hidden="true">{list.emoji} </span>}{list.name}</h2>
        {list.basket && <BasketSummary basket={list.basket} />}
        <div className="flex flex-wrap gap-2">
          {onDetail && <Button disabled={mutationLocked} onClick={() => onDetail(list.id)}>Ver canasta</Button>}
          <Button variant="outline" disabled={mutationLocked || index === 0} aria-label={`Subir ${list.name}`} onClick={() => move(index, -1)}>↑</Button>
          <Button variant="outline" disabled={mutationLocked || index === lists.length - 1} aria-label={`Bajar ${list.name}`} onClick={() => move(index, 1)}>↓</Button>
          <Button variant="outline" disabled={mutationLocked} aria-label={`Renombrar ${list.name}`} onClick={() => { setEditing(list.id); setName(list.name); setDeleting(null); setError(''); field.current?.focus(); }}>Renombrar</Button>
          <Button variant="outline" disabled={mutationLocked} aria-label={`Eliminar ${list.name}`} onClick={() => { setDeleting(list.id); setError(''); }}>Eliminar</Button>
          <Button variant="outline" disabled={mutationLocked} aria-label={`Configurar canasta de ${list.name}`} onClick={() => { setBasketId(list.id); setBudget(list.basket?.budget != null ? String(list.basket.budget) : ''); setCurrency(list.basket?.currency ?? 'PEN'); setError(''); }}>Canasta</Button>
        </div>
        {basketId === list.id && <form className="mt-5 space-y-3 border-t border-border pt-4" onSubmit={event => {
          event.preventDefault();
          if (mutationLocked) return;
          const amount = parseBudget(budget);
          if (amount === null || !/^[A-Z]{3}$/.test(currency)) { setError('Indica un gasto máximo positivo con hasta dos decimales y una moneda de tres letras.'); return; }
          void run('basket', { basket_budget: amount, basket_currency: currency }, list.id);
        }}>
          <p className="text-sm text-muted-foreground">Configura el gasto máximo de esta canasta. Avisa cuando el total completo sea menor o igual al gasto máximo.</p>
          <label className="block text-sm" htmlFor={`basket-budget-${list.id}`}>Gasto máximo<Input id={`basket-budget-${list.id}`} className="mt-2" inputMode="decimal" value={budget} disabled={mutationLocked} onChange={event => setBudget(event.target.value)} placeholder="Por ejemplo, 500.00" /></label>
          <label className="block text-sm" htmlFor={`basket-currency-${list.id}`}>Moneda de la canasta<Input id={`basket-currency-${list.id}`} className="mt-2" value={currency} maxLength={3} disabled={mutationLocked} onChange={event => setCurrency(event.target.value.toUpperCase())} placeholder="PEN" /></label>
          <div className="flex flex-wrap gap-2">
          <Button type="submit" disabled={mutationLocked}>Guardar canasta</Button>{list.basket && <Button type="button" variant="outline" disabled={mutationLocked} onClick={() => void run('basket', { basket_budget: null, basket_currency: null }, list.id)}>Desactivar canasta</Button>}<Button type="button" variant="outline" disabled={locked} onClick={() => setBasketId(null)}>Cancelar canasta</Button></div>
        </form>}
        {deleting === list.id && <div className="mt-5 border-t border-border pt-4">
          <p className="mb-3 break-words text-sm">¿Eliminar «{list.name}»? Los productos y su historial individual se conservan; se elimina el historial de esta canasta.</p>
          <div className="flex flex-wrap gap-2">
          <Button variant="outline" className="text-destructive" disabled={mutationLocked} onClick={() => void run('delete', undefined, list.id)}>Confirmar eliminación</Button><Button variant="outline" disabled={locked} onClick={() => setDeleting(null)}>Cancelar eliminación</Button></div>
        </div>}
      </li>)}</ol>}
  </section>;
}
