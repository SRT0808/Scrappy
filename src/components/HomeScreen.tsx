import { useEffect, useRef, useState } from 'react';
import { Button } from './ui/button';
import { AddProduct } from './AddProduct';
import { ListsScreen } from './ListsScreen';
import { ProductCard } from './ProductCard';
import { ProductDetailScreen } from './ProductDetailScreen';
import { SettingsScreen } from './SettingsScreen';
import { BasketDetailScreen } from './BasketDetailScreen';
import { requestLists, type List } from '../lib/lists';
import { productMetrics, requestProducts, type ProductSummary } from '../lib/products';

type Props = { onExpired: (message: string) => void; onLogout: () => void; sessionBusy: boolean; sessionError: string };
type Filter = 'all' | ProductSummary['status'] | 'reached';
type Sort = 'recent' | 'name' | 'discount';
const selectClass = 'mt-2 h-12 w-full min-w-0 rounded-lg border border-input bg-card px-3 text-sm focus-visible:outline-2 focus-visible:outline-ring';

export function HomeScreen(props: Props) {
  const [view, setView] = useState<'home' | 'lists' | 'add' | 'detail' | 'settings' | 'basket-detail'>('home');
  const [detailId, setDetailId] = useState('');
  const [lists, setLists] = useState<List[]>([]);
  const [products, setProducts] = useState<ProductSummary[]>([]);
  const [productsBusy, setProductsBusy] = useState(true);
  const [productsError, setProductsError] = useState('');
  const [notice, setNotice] = useState('');
  const [refresh, setRefresh] = useState(0);
  const [filter, setFilter] = useState<Filter>('all');
  const [sort, setSort] = useState<Sort>('recent');
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const homeTitle = useRef<HTMLHeadingElement>(null);
  const expired = useRef(props.onExpired);
  expired.current = props.onExpired;

  useEffect(() => {
    document.title = `Scrappy · ${view === 'home' ? 'Productos' : view === 'lists' ? 'Canastas' : view === 'detail' ? 'Detalle de producto' : view === 'basket-detail' ? 'Detalle de canasta' : view === 'settings' ? 'Ajustes' : 'Añadir producto'}`;
    if (view !== 'home') return;
    const controller = new AbortController();
    requestLists('read', undefined, undefined, controller.signal).then(rows => {
      if (controller.signal.aborted) return;
      setLists(rows);
    }).catch((failure: { status: number; message: string }) => {
      if (controller.signal.aborted) return;
      if (failure.status === 401) expired.current(failure.message);
    });
    return () => controller.abort();
  }, [view, refresh]);

  useEffect(() => {
    if (view !== 'home') return;
    const controller = new AbortController();
    setProductsBusy(true);
    setProductsError('');
    setProducts([]);
    requestProducts('', controller.signal).then(rows => {
      if (!controller.signal.aborted) setProducts(rows);
    }).catch((failure: { status: number; message: string }) => {
      if (controller.signal.aborted) return;
      if (failure.status === 401) expired.current(failure.message);
      else setProductsError(failure.message);
    }).finally(() => { if (!controller.signal.aborted) setProductsBusy(false); });
    return () => controller.abort();
  }, [view, refresh]);

  function returnHome() {
    setView('home');
    setMobileNavOpen(false);
    setTimeout(() => homeTitle.current?.focus(), 0);
  }
  function navigate(next: 'home' | 'lists' | 'settings' | 'add') {
    setMobileNavOpen(false);
    if (next === 'home') { returnHome(); return; }
    if (next === 'add') setNotice('');
    setView(next);
  }

  const visible = products.filter(product => filter === 'all' || (filter === 'reached' ? productMetrics(product).reached : product.status === filter))
    .sort((a, b) => sort === 'name' ? (a.name || a.domain).localeCompare(b.name || b.domain, 'es')
      : sort === 'discount' ? (productMetrics(a).variation ?? Infinity) - (productMetrics(b).variation ?? Infinity)
        : Date.parse(b.created_at) - Date.parse(a.created_at));
  const loading = productsBusy;
  const error = productsError || props.sessionError;
  const page = view === 'lists' ? <ListsScreen {...props} onDetail={id => { setDetailId(id); setView('basket-detail'); }} showLogout={false} onHome={() => returnHome()} />
    : view === 'basket-detail' ? <BasketDetailScreen key={detailId} id={detailId} onExpired={props.onExpired} onBack={() => setView('lists')} />
    : view === 'settings' ? <SettingsScreen onExpired={props.onExpired} onBack={() => returnHome()} />
      : view === 'detail' ? <ProductDetailScreen key={detailId} id={detailId} lists={lists} onExpired={props.onExpired} onBack={() => returnHome()} onDeleted={() => { setNotice('Producto e historial eliminados.'); returnHome(); }} />
        : view === 'add' ? <AddProduct lists={lists} onExpired={props.onExpired} onCloseLabel="Volver a Inicio" onClose={returnHome} onSaved={() => { setNotice('Producto guardado y activo.'); returnHome(); }} />
          : <section aria-labelledby="home-title" className="mx-auto w-full min-w-0 self-start">
    <div className="mb-7 flex flex-wrap items-start justify-between gap-4">
      <div><p className="mb-2 text-xs font-medium tracking-[0.16em] text-primary uppercase">Tu radar de precios</p><h1 ref={homeTitle} tabIndex={-1} id="home-title" className="text-3xl font-semibold tracking-tight outline-none">Productos</h1><p className="mt-3 text-sm text-muted-foreground">Tus productos, más cerca de su mejor precio.</p></div>
      {!mobileNavOpen && <Button className="lg:hidden" disabled={props.sessionBusy} onClick={() => navigate('add')}>Añadir producto</Button>}
    </div>
    {error && <p role="alert" className="mb-4 text-sm leading-relaxed text-destructive">{error}</p>}
    <p role="status" className="mb-4 text-sm text-primary">{loading ? 'Cargando tus productos…' : notice}</p>
    {<>
      <div className="mb-6 grid min-w-0 grid-cols-1 gap-4 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
        <label className="min-w-0 text-sm text-muted-foreground" htmlFor="product-filter">Estado<select id="product-filter" className={selectClass} value={filter} onChange={event => setFilter(event.target.value as Filter)}><option value="all">Todos</option><option value="active">Activos</option><option value="paused">Pausados</option><option value="error">Con error</option><option value="pending_confirmation">Por confirmar</option><option value="reached">Meta alcanzada</option></select></label>
        <label className="min-w-0 text-sm text-muted-foreground" htmlFor="product-sort">Orden<select id="product-sort" className={selectClass} value={sort} onChange={event => setSort(event.target.value as Sort)}><option value="recent">Más recientes</option><option value="name">Nombre: A–Z</option><option value="discount">Mayor bajada frente a referencia</option></select></label>
        <Button variant="outline" disabled={loading || props.sessionBusy} onClick={() => setRefresh(value => value + 1)}>Actualizar productos</Button>
      </div>
    </>}
    {loading ? <div aria-hidden="true" className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3">{[0, 1, 2].map(key => <div key={key} className="h-96 rounded-2xl border border-border bg-card motion-safe:animate-pulse" />)}</div>
      : error ? <Button variant="outline" disabled={props.sessionBusy} onClick={() => setRefresh(value => value + 1)}>Reintentar consulta</Button>
        : visible.length === 0 ? <div className="rounded-2xl border border-dashed border-border p-8 text-center"><h2 className="font-semibold">{products.length ? 'No hay productos con este estado' : 'Tu catálogo espera tu próximo producto'}</h2><p className="mt-3 text-sm text-muted-foreground">{products.length ? 'Prueba otro filtro para ver tus productos.' : 'Añade una URL para empezar a seguir su precio.'}</p></div>
            : <><p className="mb-4 text-sm text-muted-foreground">{visible.length} {visible.length === 1 ? 'producto' : 'productos'}</p><div className="grid min-w-0 grid-cols-1 items-start gap-5 sm:grid-cols-2 lg:grid-cols-3">{visible.map(product => <ProductCard key={product.id} product={product} onDetail={() => { setDetailId(product.id); setView('detail'); }} />)}</div></>}
  </section>;

  const currentSection = view === 'lists' || view === 'basket-detail' ? 'lists' : view === 'settings' ? 'settings' : view === 'add' ? 'add' : 'home';
  const navButtonClass = (active: boolean) => `w-full justify-start ${active ? 'border-primary/50 bg-muted' : ''}`;
  return <div className="w-full flex-1 px-5 py-5 sm:py-6">
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-5 lg:flex-row lg:gap-8">
      <aside aria-label="Navegación de Scrappy" className="w-full shrink-0 lg:w-56 lg:rounded-2xl lg:border lg:border-border lg:bg-card lg:p-4">
        <div className="mb-5 flex items-center justify-between lg:hidden">
          <div className="flex items-center gap-3">
            <span aria-hidden="true" className="flex size-9 items-center justify-center rounded-xl bg-primary text-primary-foreground">
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m4 9 6 6L20 5M13 5h7v7" /></svg>
            </span>
            <span className="text-lg font-semibold tracking-tight">scrappy<span className="text-primary">.</span></span>
          </div>
          <Button variant="outline" aria-expanded={mobileNavOpen} aria-controls="app-navigation" onClick={() => setMobileNavOpen(value => !value)}>
            <svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d={mobileNavOpen ? 'M18 6 6 18M6 6l12 12' : 'M4 6h16M4 12h16M4 18h16'} /></svg>
            {mobileNavOpen ? 'Cerrar' : 'Menú'}
          </Button>
        </div>
        <div className="hidden items-center gap-3 lg:mb-8 lg:flex">
          <span aria-hidden="true" className="flex size-9 items-center justify-center rounded-xl bg-primary text-primary-foreground">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m4 9 6 6L20 5M13 5h7v7" /></svg>
          </span>
          <span className="text-lg font-semibold tracking-tight">scrappy<span className="text-primary">.</span></span>
        </div>
        <div id="app-navigation" className={mobileNavOpen ? 'space-y-5 rounded-2xl border border-border bg-card p-4 lg:space-y-6 lg:border-0 lg:bg-transparent lg:p-0' : 'hidden lg:block'}>
          <div>
            <p className="mb-2 px-3 text-xs font-medium tracking-[0.14em] text-muted-foreground uppercase">Seguimiento</p>
            <nav aria-label="Navegación principal" className="grid gap-1">
              <Button variant="outline" className={navButtonClass(currentSection === 'home')} aria-current={currentSection === 'home' ? 'page' : undefined} onClick={() => navigate('home')}>Productos</Button>
              <Button variant="outline" className={navButtonClass(currentSection === 'lists')} aria-label="Gestionar canastas" aria-current={currentSection === 'lists' ? 'page' : undefined} disabled={props.sessionBusy} onClick={() => navigate('lists')}>Canastas</Button>
            </nav>
          </div>
          <Button className="w-full" disabled={props.sessionBusy} onClick={() => navigate('add')}>Añadir producto</Button>
          <div className="border-t border-border pt-4 lg:mt-8">
            <nav aria-label="Cuenta" className="grid gap-1">
              <Button variant="outline" className={navButtonClass(currentSection === 'settings')} aria-current={currentSection === 'settings' ? 'page' : undefined} disabled={props.sessionBusy} onClick={() => navigate('settings')}>Ajustes</Button>
              <Button variant="outline" className="w-full justify-start" disabled={props.sessionBusy} onClick={props.onLogout}>{props.sessionBusy ? 'Cerrando sesión…' : 'Cerrar sesión'}</Button>
            </nav>
          </div>
        </div>
      </aside>
      <main className="min-w-0 flex-1 pt-1">{page}</main>
    </div>
  </div>;
}
