import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { ListsError, requestLists, type List, type ListAction } from '../lib/lists';
import { AddProduct } from './AddProduct';

type Props = { onExpired: (message: string) => void; onLogout: () => void; sessionBusy: boolean; sessionError: string; onHome?: () => void; onProductSaved?: () => void };

export function ListsScreen({ onExpired, onLogout, sessionBusy, sessionError, onHome, onProductSaved }: Props) {
  const [lists, setLists] = useState<List[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [name, setName] = useState('');
  const [editing, setEditing] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [needsRefresh, setNeedsRefresh] = useState(false);
  const [adding, setAdding] = useState(false);
  const addButton = useRef<HTMLButtonElement>(null);
  const active = useRef<AbortController | null>(null);
  const field = useRef<HTMLInputElement>(null);
  const locked = busy || sessionBusy;
  const mutationLocked = locked || needsRefresh;

  async function run(action: ListAction, body?: { name: string } | { ids: string[] }, id?: string) {
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
        : action === 'rename' ? current.map(row => row.id === id ? rows[0] : row)
        : action === 'delete' ? current.filter(row => row.id !== id) : rows);
      setLoaded(true);
      setNeedsRefresh(false);
      setName('');
      setEditing(null);
      setDeleting(null);
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

  if (adding) return <AddProduct lists={lists} onExpired={onExpired} onClose={() => { setAdding(false); setTimeout(() => addButton.current?.focus(), 0); }} onSaved={() => { setAdding(false); setNotice('Producto guardado y activo.'); onProductSaved?.(); setTimeout(() => addButton.current?.focus(), 0); }} />;

  return <section aria-labelledby="lists-title" aria-busy={locked} className="mx-auto w-full max-w-2xl self-start">
    <div className="mb-8 flex flex-wrap items-start justify-between gap-4">
      <div><p className="mb-2 text-xs font-medium tracking-[0.16em] text-primary uppercase">Tu radar de precios</p><h1 id="lists-title" className="text-3xl font-semibold tracking-tight">Tus listas</h1><p className="mt-3 text-sm text-muted-foreground">Organiza lo que quieres seguir, a tu manera.</p></div>
      <Button variant="outline" disabled={locked} onClick={onLogout}>{sessionBusy ? 'Cerrando sesión…' : 'Cerrar sesión'}</Button>
    </div>
    <div className="mb-6 flex flex-wrap gap-3">{onHome && <Button variant="outline" disabled={locked} onClick={onHome}>Volver a Inicio</Button>}<Button ref={addButton} disabled={mutationLocked || !loaded} onClick={() => { setAdding(true); setNotice(''); }}>Añadir producto</Button></div>
    <form onSubmit={save} className="mb-6 rounded-2xl border border-border bg-card p-5 sm:p-6">
      <label htmlFor="list-name" className="text-sm font-medium">{editing ? 'Nuevo nombre' : 'Nombre de la nueva lista'}</label>
      <div className="mt-3 flex flex-col gap-3 sm:flex-row">
        <Input ref={field} id="list-name" value={name} disabled={mutationLocked || !loaded} onChange={event => setName(event.target.value)} placeholder="Por ejemplo, Tecnología" aria-describedby="list-name-help" />
        <Button type="submit" disabled={mutationLocked || !loaded}>{editing ? 'Guardar nombre' : 'Crear lista'}</Button>
        {editing && <Button variant="outline" type="button" disabled={locked} onClick={() => { setEditing(null); setName(''); field.current?.focus(); }}>Cancelar</Button>}
      </div>
      <p id="list-name-help" className="mt-3 text-xs text-muted-foreground">Entre 1 y 100 caracteres.</p>
    </form>
    {(error || sessionError) && <p role="alert" className="mb-4 text-sm leading-relaxed text-destructive">{error || sessionError}</p>}
    <p role="status" className="mb-4 text-sm text-primary">{busy ? 'Guardando o cargando listas…' : notice}</p>
    <div className="mb-4 flex items-center justify-between gap-3"><p className="text-sm text-muted-foreground">{loaded ? `${lists.length} ${lists.length === 1 ? 'lista' : 'listas'}` : 'Tus colecciones'}</p><Button variant="outline" disabled={locked} onClick={() => void run('read')}>Actualizar listas</Button></div>
    {!loaded && busy ? <div aria-hidden="true" className="space-y-3">{[0, 1, 2].map(key => <div key={key} className="h-28 rounded-2xl border border-border bg-card motion-safe:animate-pulse" />)}</div>
      : loaded && lists.length === 0 ? <div className="rounded-2xl border border-dashed border-border p-8 text-center"><h2 className="font-semibold">Tu primera lista empieza aquí</h2><p className="mt-2 text-sm text-muted-foreground">Crea una lista para organizar tus próximos productos.</p></div>
      : <ol className="space-y-3">{lists.map((list, index) => <li key={list.id} className="rounded-2xl border border-border bg-card p-5">
        <h2 className="mb-4 break-words text-lg font-medium">{list.emoji && <span aria-hidden="true">{list.emoji} </span>}{list.name}</h2>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" disabled={mutationLocked || index === 0} aria-label={`Subir ${list.name}`} onClick={() => move(index, -1)}>↑</Button>
          <Button variant="outline" disabled={mutationLocked || index === lists.length - 1} aria-label={`Bajar ${list.name}`} onClick={() => move(index, 1)}>↓</Button>
          <Button variant="outline" disabled={mutationLocked} aria-label={`Renombrar ${list.name}`} onClick={() => { setEditing(list.id); setName(list.name); setDeleting(null); setError(''); field.current?.focus(); }}>Renombrar</Button>
          <Button variant="outline" disabled={mutationLocked} aria-label={`Eliminar ${list.name}`} onClick={() => { setDeleting(list.id); setError(''); }}>Eliminar</Button>
        </div>
        {deleting === list.id && <div className="mt-5 border-t border-border pt-4">
          <p className="mb-3 break-words text-sm">¿Eliminar «{list.name}»? Solo se puede eliminar si no contiene productos.</p>
          <div className="flex flex-wrap gap-2"><Button variant="outline" className="text-destructive" disabled={mutationLocked} onClick={() => void run('delete', undefined, list.id)}>Confirmar eliminación</Button><Button variant="outline" disabled={locked} onClick={() => setDeleting(null)}>Cancelar eliminación</Button></div>
        </div>}
      </li>)}</ol>}
  </section>;
}
