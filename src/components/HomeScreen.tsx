import { useEffect, useRef, useState } from 'react';
import { Button } from './ui/button';
import { AddProduct } from './AddProduct';
import { ListsScreen } from './ListsScreen';
import { ProductCard } from './ProductCard';
import { ProductDetailScreen } from './ProductDetailScreen';
import { SettingsScreen } from './SettingsScreen';
import { requestLists, type List } from '../lib/lists';
import { productMetrics, requestProducts, type ProductSummary } from '../lib/products';

type Props = { onExpired: (message: string) => void; onLogout: () => void; sessionBusy: boolean; sessionError: string };
type Filter = 'all' | ProductSummary['status'] | 'reached';
type Sort = 'recent' | 'name' | 'discount';
const selectClass = 'mt-2 h-12 w-full min-w-0 rounded-lg border border-input bg-card px-3 text-sm focus-visible:outline-2 focus-visible:outline-ring';

export function HomeScreen(props: Props) {
  const [view, setView] = useState<'home' | 'lists' | 'add' | 'detail' | 'settings'>('home');
  const [detailId, setDetailId] = useState('');
  const [lists, setLists] = useState<List[]>([]);
  const [selected, setSelected] = useState('');
  const [products, setProducts] = useState<ProductSummary[]>([]);
  const [listsLoaded, setListsLoaded] = useState(false);
  const [listsBusy, setListsBusy] = useState(true);
  const [productsBusy, setProductsBusy] = useState(false);
  const [listsError, setListsError] = useState('');
  const [productsError, setProductsError] = useState('');
  const [notice, setNotice] = useState('');
  const [refresh, setRefresh] = useState(0);
  const [filter, setFilter] = useState<Filter>('all');
  const [sort, setSort] = useState<Sort>('recent');
  const addButton = useRef<HTMLButtonElement>(null);
  const homeButton = useRef<HTMLButtonElement>(null);
  const expired = useRef(props.onExpired);
  expired.current = props.onExpired;

  useEffect(() => {
    document.title = `Scrappy · ${view === 'home' ? 'Inicio' : view === 'lists' ? 'Listas' : view === 'detail' ? 'Detalle de producto' : view === 'settings' ? 'Ajustes' : 'Añadir producto'}`;
    if (view !== 'home') return;
    const controller = new AbortController();
    setListsBusy(true);
    setListsError('');
    requestLists('read', undefined, undefined, controller.signal).then(rows => {
      if (controller.signal.aborted) return;
      setLists(rows);
      setListsLoaded(true);
      setSelected(current => rows.some(row => row.id === current) ? current : rows[0]?.id ?? '');
    }).catch((failure: { status: number; message: string }) => {
      if (controller.signal.aborted) return;
      if (failure.status === 401) expired.current(failure.message);
      else setListsError(failure.message);
    }).finally(() => { if (!controller.signal.aborted) setListsBusy(false); });
    return () => controller.abort();
  }, [view, refresh]);

  useEffect(() => {
    if (view !== 'home' || listsBusy || listsError || !selected) {
      setProductsBusy(false);
      if (!selected) { setProducts([]); setProductsError(''); }
      return;
    }
    const controller = new AbortController();
    setProductsBusy(true);
    setProductsError('');
    setProducts([]);
    requestProducts(selected, controller.signal).then(rows => {
      if (!controller.signal.aborted) setProducts(rows);
    }).catch((failure: { status: number; message: string }) => {
      if (controller.signal.aborted) return;
      if (failure.status === 401) expired.current(failure.message);
      else setProductsError(failure.message);
    }).finally(() => { if (!controller.signal.aborted) setProductsBusy(false); });
    return () => controller.abort();
  }, [selected, view, listsBusy, listsError]);

  function returnHome(focus: 'add' | 'home' = 'home') {
    setListsBusy(true);
    setView('home');
    setTimeout(() => (focus === 'add' ? addButton : homeButton).current?.focus(), 0);
  }
  if (view === 'lists') return <ListsScreen {...props} onHome={() => returnHome()} onProductSaved={() => { setNotice('Producto guardado y activo.'); returnHome('add'); }} />;
  if (view === 'settings') return <SettingsScreen onExpired={props.onExpired} onBack={() => returnHome()} />;
  if (view === 'detail') return <ProductDetailScreen key={detailId} id={detailId} lists={lists} onExpired={props.onExpired} onBack={() => returnHome()} onDeleted={() => { setNotice('Producto e historial eliminados.'); returnHome(); }} />;
  if (view === 'add') return <AddProduct lists={[...lists.filter(row => row.id === selected), ...lists.filter(row => row.id !== selected)]} onExpired={props.onExpired} onClose={() => returnHome('add')} onSaved={(_id, listId) => { setSelected(listId); setNotice('Producto guardado y activo.'); returnHome('add'); }} />;

  const visible = products.filter(product => filter === 'all' || (filter === 'reached' ? productMetrics(product).reached : product.status === filter))
    .sort((a, b) => sort === 'name' ? (a.name || a.domain).localeCompare(b.name || b.domain, 'es')
      : sort === 'discount' ? (productMetrics(a).variation ?? Infinity) - (productMetrics(b).variation ?? Infinity)
        : Date.parse(b.created_at) - Date.parse(a.created_at));
  const loading = listsBusy || productsBusy;
  const error = listsError || productsError || props.sessionError;
  return <section aria-labelledby="home-title" className="mx-auto w-full min-w-0 max-w-6xl self-start">
    <div className="mb-7 flex flex-wrap items-start justify-between gap-4">
      <div><p className="mb-2 text-xs font-medium tracking-[0.16em] text-primary uppercase">Tu radar de precios</p><h1 id="home-title" className="text-3xl font-semibold tracking-tight">Inicio</h1><p className="mt-3 text-sm text-muted-foreground">Tus productos, más cerca de su mejor precio.</p></div>
      <Button variant="outline" disabled={props.sessionBusy} onClick={props.onLogout}>{props.sessionBusy ? 'Cerrando sesión…' : 'Cerrar sesión'}</Button>
    </div>
    <nav aria-label="Pantallas" className="mb-6 flex flex-wrap gap-3"><Button ref={homeButton} variant="outline" aria-current="page">Inicio</Button><Button variant="outline" disabled={props.sessionBusy} onClick={() => setView('lists')}>Gestionar listas</Button><Button variant="outline" disabled={props.sessionBusy} onClick={() => setView('settings')}>Ajustes</Button><Button ref={addButton} disabled={!listsLoaded || listsBusy || !!listsError || props.sessionBusy} onClick={() => { setNotice(''); setView('add'); }}>Añadir producto</Button></nav>
    {error && <p role="alert" className="mb-4 text-sm leading-relaxed text-destructive">{error}</p>}
    <p role="status" className="mb-4 text-sm text-primary">{loading ? 'Cargando tus productos…' : notice}</p>
    {listsLoaded && lists.length > 0 && <>
      <nav aria-label="Listas de productos" className="mb-6 flex min-w-0 flex-wrap gap-2">{lists.map(list => <Button key={list.id} variant={selected === list.id ? 'default' : 'outline'} aria-pressed={selected === list.id} className="min-w-0 max-w-full whitespace-normal text-left [overflow-wrap:anywhere]" disabled={props.sessionBusy || listsBusy} onClick={() => { if (selected === list.id) return; setProductsBusy(true); setProducts([]); setProductsError(''); setSelected(list.id); setFilter('all'); setNotice(''); }}>{list.emoji && <span aria-hidden="true">{list.emoji}</span>}{list.name}</Button>)}</nav>
      <div className="mb-6 grid min-w-0 grid-cols-1 gap-4 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
        <label className="min-w-0 text-sm text-muted-foreground" htmlFor="product-filter">Estado<select id="product-filter" className={selectClass} value={filter} onChange={event => setFilter(event.target.value as Filter)}><option value="all">Todos</option><option value="active">Activos</option><option value="paused">Pausados</option><option value="error">Con error</option><option value="pending_confirmation">Por confirmar</option><option value="reached">Meta alcanzada</option></select></label>
        <label className="min-w-0 text-sm text-muted-foreground" htmlFor="product-sort">Orden<select id="product-sort" className={selectClass} value={sort} onChange={event => setSort(event.target.value as Sort)}><option value="recent">Más recientes</option><option value="name">Nombre: A–Z</option><option value="discount">Mayor bajada frente a referencia</option></select></label>
        <Button variant="outline" disabled={loading || props.sessionBusy} onClick={() => { setListsBusy(true); setRefresh(value => value + 1); }}>Actualizar productos</Button>
      </div>
    </>}
    {loading ? <div aria-hidden="true" className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3">{[0, 1, 2].map(key => <div key={key} className="h-96 rounded-2xl border border-border bg-card motion-safe:animate-pulse" />)}</div>
      : error ? <Button variant="outline" disabled={props.sessionBusy} onClick={() => { setListsBusy(true); setRefresh(value => value + 1); }}>Reintentar consulta</Button>
        : listsLoaded && lists.length === 0 ? <div className="rounded-2xl border border-dashed border-border p-8 text-center"><h2 className="font-semibold">Tu primera lista empieza aquí</h2><p className="mt-3 text-sm text-muted-foreground">Crea una lista y añade los productos que quieres seguir.</p><Button className="mt-5" onClick={() => setView('lists')}>Crear mi primera lista</Button></div>
          : listsLoaded && visible.length === 0 ? <div className="rounded-2xl border border-dashed border-border p-8 text-center"><h2 className="font-semibold">{products.length ? 'No hay productos con este estado' : 'Esta lista espera tu próximo producto'}</h2><p className="mt-3 text-sm text-muted-foreground">{products.length ? 'Prueba otro filtro para ver tus productos.' : 'Añade una URL para empezar a seguir su precio.'}</p></div>
            : <><p className="mb-4 text-sm text-muted-foreground">{visible.length} {visible.length === 1 ? 'producto' : 'productos'}</p><div className="grid min-w-0 grid-cols-1 items-start gap-5 sm:grid-cols-2 lg:grid-cols-3">{visible.map(product => <ProductCard key={product.id} product={product} onDetail={() => { setDetailId(product.id); setView('detail'); }} />)}</div></>}
  </section>;
}
