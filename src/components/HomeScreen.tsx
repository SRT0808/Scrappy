import { useEffect, useRef, useState } from 'react';
import { Check, Package, Plus, RefreshCw, Settings, ShoppingBasket, SlidersHorizontal } from 'lucide-react';
import { Button } from './ui/button';
import { EmptyState } from './ui/empty-state';
import { Logo } from './ui/logo';
import { Notice } from './ui/notice';
import { selectClass as baseSelectClass } from './ui/select';
import { Skeleton } from './ui/skeleton';
import { cn } from '../lib/utils';
import { AddProduct } from './AddProduct';
import { ListsScreen } from './ListsScreen';
import { ProductCard, staleReading } from './ProductCard';
import { ProductDetailScreen } from './ProductDetailScreen';
import { SettingsScreen } from './SettingsScreen';
import { PurchaseBasketScreen } from './PurchaseBasketScreen';
import { requestLists, type List } from '../lib/lists';
import { productMetrics, requestProducts, type ProductSummary } from '../lib/products';
import { uuidPattern } from '../../lib/product-contract';
import { groupRequest, bestGroupOffer, type ProductGroup, type GroupEdit } from '../lib/groups';
import { GroupCard } from './GroupCard';
import { GroupEditor } from './GroupEditor';
import { GroupDetailScreen } from './GroupDetailScreen';

type Props = { onExpired: (message: string) => void; onLogout: () => void; sessionBusy: boolean; sessionError: string };
type Filter = 'all' | ProductSummary['status'] | 'reached' | 'stale';
type Sort = 'recent' | 'name' | 'discount';
type View = 'home' | 'lists' | 'add' | 'detail' | 'settings' | 'basket-detail' | 'group' | 'group-create';
type Section = 'home' | 'lists' | 'settings' | 'add';
type Route = { view: View; id: string; event?: string };
const home: Route = { view: 'home', id: '' };
const routeKeys = ['view', 'product', 'basket', 'group', 'group_event'];
const pageViews: View[] = ['lists', 'settings', 'add', 'group-create'];

// The URL is the source of truth for the current view, so browser history and reloads restore it.
function readRoute(): Route {
  const params = new URLSearchParams(window.location.search);
  const single = (key: string) => { const values = params.getAll(key); return values.length === 1 ? values[0] : ''; };
  const id = (key: string) => { const value = single(key); return uuidPattern.test(value) ? value.toLowerCase() : ''; };
  const group = id('group'), basket = id('basket'), product = id('product');
  if (group) { const event = single('group_event'); return event ? { view: 'group', id: group, event } : { view: 'group', id: group }; }
  if (basket) return { view: 'basket-detail', id: basket };
  if (product) return { view: 'detail', id: product };
  const view = pageViews.find(name => name === single('view'));
  return view ? { view, id: '' } : home;
}
function routeUrl(route: Route) {
  const url = new URL(window.location.href);
  routeKeys.forEach(key => url.searchParams.delete(key));
  if (route.view === 'detail') url.searchParams.set('product', route.id);
  else if (route.view === 'basket-detail') url.searchParams.set('basket', route.id);
  else if (route.view === 'group') { url.searchParams.set('group', route.id); if (route.event) url.searchParams.set('group_event', route.event); }
  else if (route.view !== 'home') url.searchParams.set('view', route.view);
  return url.pathname + url.search + url.hash;
}
const currentUrl = () => window.location.pathname + window.location.search + window.location.hash;
const selectClass = cn('mt-1.5', baseSelectClass);

export function HomeScreen(props: Props) {
  const [groups,setGroups]=useState<ProductGroup[]>([]);
  const [selected,setSelected]=useState<string[]>([]);
  const [groupBusy,setGroupBusy]=useState(false);
  const [offerGroup,setOfferGroup]=useState<ProductGroup|null>(null);
  const groupSaving=useRef(false);
  const creationId=useRef<string|null>(null);
  // A group draft depends on the in-memory selection, so it cannot be restored from a reload.
  const [route, setRoute] = useState<Route>(() => { const initial = readRoute(); return initial.view === 'group-create' ? home : initial; });
  const { view, id: detailId } = route;
  const [lists, setLists] = useState<List[]>([]);
  const [products, setProducts] = useState<ProductSummary[]>([]);
  const [productsBusy, setProductsBusy] = useState(true);
  const [productsError, setProductsError] = useState('');
  const [notice, setNotice] = useState('');
  const [refresh, setRefresh] = useState(0);
  const [filter, setFilter] = useState<Filter>('all');
  const [sort, setSort] = useState<Sort>('recent');
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [basketName, setBasketName] = useState('');
  const [basketBusy, setBasketBusy] = useState(false);
  const [basketDirty, setBasketDirty] = useState(false);
  const [pendingNavigation, setPendingNavigation] = useState<Route | 'logout' | null>(null);
  const homeTitle = useRef<HTMLHeadingElement>(null);
  const expired = useRef(props.onExpired);
  expired.current = props.onExpired;

  useEffect(() => {
    document.title = `Scrappy · ${view === 'home' ? 'Productos' : view === 'lists' ? 'Canastas' : view === 'detail' ? 'Detalle de producto' : view === 'basket-detail' ? 'Detalle de canasta' : view === 'settings' ? 'Ajustes' : view === 'group' ? 'Detalle de grupo' : view === 'group-create' ? 'Crear grupo' : 'Añadir producto'}`;
    if (view !== 'home' && view !== 'basket-detail') return;
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
    Promise.all([requestProducts('', controller.signal),groupRequest(undefined,undefined,controller.signal)]).then(([rows,groupRows]) => {
      if (!controller.signal.aborted) {
        setProducts(rows);setGroups(groupRows);
        const grouped = new Set(groupRows.flatMap(group => group.offers.map(offer => offer.id)));
        setSelected(current => current.filter(id => rows.some(product => product.id === id && product.status !== 'pending_confirmation') && !grouped.has(id)));
      }
    }).catch((failure: { status: number; message: string }) => {
      if (controller.signal.aborted) return;
      if (failure.status === 401) expired.current(failure.message);
      else setProductsError(failure.message);
    }).finally(() => { if (!controller.signal.aborted) setProductsBusy(false); });
    return () => controller.abort();
  }, [view, refresh]);

  useEffect(() => {
    // Only the initial URL needs normalising; later routes are written by go().
    const url = routeUrl(route);
    if (url !== currentUrl()) window.history.replaceState(window.history.state, '', url);
  }, []);

  useEffect(() => {
    function onPopState() {
      let next = readRoute();
      if (next.view === 'group-create' && !compatible) { next = home; window.history.replaceState(window.history.state, '', routeUrl(home)); }
      if (basketBusy || groupBusy || basketDirty) {
        // History cannot be cancelled: restore the current entry and, with unsaved edits, ask before leaving.
        window.history.pushState(null, '', routeUrl(route));
        if (basketDirty && !basketBusy && !groupBusy) setPendingNavigation(next);
        return;
      }
      if (next.view !== 'detail' && next.view !== 'group') setOfferGroup(null);
      creationId.current = null;
      setMobileNavOpen(false);
      setRoute(next);
      if (next.view === 'home') setTimeout(() => homeTitle.current?.focus(), 0);
    }
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  });

  function go(next: Route, replace = false) {
    const url = routeUrl(next);
    if (url !== currentUrl()) window.history[replace ? 'replaceState' : 'pushState'](null, '', url);
    setRoute(next);
  }
  function returnHome(replace = false) {
    if (basketBusy || groupBusy) return;
    if (basketDirty) { setPendingNavigation(home); return; }
    completeNavigation(home, replace);
    setTimeout(() => homeTitle.current?.focus(), 0);
  }
  function navigate(next: Section) {
    if (basketBusy || groupBusy) return;
    if (basketDirty) { setPendingNavigation({ view: next, id: '' }); return; }
    completeNavigation({ view: next, id: '' });
  }
  function completeNavigation(next: Route, replace = false) {
    setOfferGroup(null);
    creationId.current = null;
    setMobileNavOpen(false);
    if (next.view === 'add') setNotice('');
    go(next, replace);
  }

  const groupedIds=new Set(groups.flatMap(g=>g.offers.map(p=>p.id)));
  const visible = products.filter(product => !groupedIds.has(product.id) && (filter === 'all' || (filter === 'reached' ? productMetrics(product).reached : filter === 'stale' ? staleReading(product) !== null : product.status === filter)))
    .sort((a, b) => sort === 'name' ? (a.name || a.domain).localeCompare(b.name || b.domain, 'es')
      : sort === 'discount' ? (productMetrics(a).variation ?? Infinity) - (productMetrics(b).variation ?? Infinity)
        : Date.parse(b.created_at) - Date.parse(a.created_at));
  const loading = productsBusy;
  const signals = [
    { filter: 'reached' as const, label: 'En meta', dot: 'bg-good', count: products.filter(p => !groupedIds.has(p.id) && productMetrics(p).reached).length },
    { filter: 'stale' as const, label: 'Desactualizados', dot: 'bg-warn', count: products.filter(p => !groupedIds.has(p.id) && staleReading(p) !== null).length },
    { filter: 'error' as const, label: 'Con error', dot: 'bg-destructive', count: products.filter(p => !groupedIds.has(p.id) && p.status === 'error').length },
  ].filter(signal => signal.count > 0);
  const groupEditorError = productsError || props.sessionError;
  const visibleGroups=groups.filter(g=>filter==='all'||filter==='reached'&&!!bestGroupOffer(g)&&bestGroupOffer(g)!.price!<=g.target
    ||filter==='paused'&&g.paused||filter==='active'&&!g.paused&&!!bestGroupOffer(g)||filter==='error'&&!bestGroupOffer(g))
    .sort((a,b)=>sort==='name'?a.name.localeCompare(b.name,'es'):sort==='discount'
      ? ((bestGroupOffer(a)?.price??Infinity)/a.reference_price)-((bestGroupOffer(b)?.price??Infinity)/b.reference_price)
      : Date.parse(b.created_at)-Date.parse(a.created_at));
  const selectedOffers=products.filter(p=>selected.includes(p.id)&&!groupedIds.has(p.id)&&p.currency&&p.target_type&&p.reference_price!==null);
  const compatible=selectedOffers.length>=2&&new Set(selectedOffers.map(p=>p.currency)).size===1;
  async function createGroup(edit:GroupEdit) {
    if(groupSaving.current||!compatible)return;groupSaving.current=true;setGroupBusy(true);setProductsError('');
    const id=creationId.current ??= crypto.randomUUID();
    try{await groupRequest(id,{action:'create',data:{...edit,same_product:true,product_ids:selectedOffers.map(p=>p.id)}});go({view:'group',id},true);setNotice('Grupo creado.');creationId.current=null;}
    catch(e){const p=e as {status:number;message:string};if(p.status===401)props.onExpired(p.message);else {setProductsError(p.message);if(p.status===0||p.status>=500||p.status===409)go({view:'group',id},true);}}
    finally{groupSaving.current=false;setGroupBusy(false);}
  }
  const page = view === 'lists' ? <ListsScreen {...props} onDetail={(id, name) => { setBasketName(name ?? ''); go({ view: 'basket-detail', id }); }} showLogout={false} onHome={() => returnHome()} />
    : view==='group'?<GroupDetailScreen key={detailId} id={detailId} eventId={route.event} onBusyChange={setBasketBusy} onExpired={props.onExpired} onBack={()=>returnHome()} onOffer={(id,group)=>{creationId.current=null;setOfferGroup(group);go({view:'detail',id});}}/>
    : view==='group-create'&&compatible?<GroupEditor creating offers={selectedOffers.map(p=>({id:p.id,name:p.name||p.domain,currency:p.currency!,image_url:p.image_url,reference_price:p.reference_price!,target_type:p.target_type!,target_value:(p.target_type==='percent'?p.target_percent:p.target_price)??0,price:p.last_price,excluded:p.status==='active'&&!staleReading(p)?null:'Sin precio válido'}))} busy={groupBusy} error={groupEditorError} onCancel={()=>returnHome()} onSave={edit=>void createGroup(edit)}/>
    : view === 'basket-detail' ? <PurchaseBasketScreen key={detailId} id={detailId} name={basketName || lists.find(l => l.id === detailId)?.name || 'Tu canasta'} onDirtyChange={setBasketDirty} onBusyChange={setBasketBusy} onExpired={props.onExpired} onBack={() => navigate('lists')} />
    : view === 'settings' ? <SettingsScreen onExpired={props.onExpired} onBack={() => returnHome()} />
      : view === 'detail' ? <ProductDetailScreen group={offerGroup?.offers.some(p=>p.id===detailId)?offerGroup:undefined} onGroup={()=>{if(offerGroup)go({view:'group',id:offerGroup.id});}} key={detailId} id={detailId} lists={lists} onExpired={props.onExpired} onBack={() => returnHome()} onDeleted={() => { setNotice('Producto e historial eliminados.'); returnHome(true); }} />
        : view === 'add' ? <AddProduct lists={lists} onExpired={props.onExpired} onCloseLabel="Volver a Inicio" onClose={() => returnHome()} onSaved={() => { setNotice('Producto guardado y activo.'); returnHome(true); }} />
          : <section aria-labelledby="home-title" className={cn('mx-auto w-full max-w-7xl min-w-0 self-start', selected.length > 0 && 'pb-56 sm:pb-40 lg:pb-32')}>
    <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
      <div className="space-y-1"><h1 ref={homeTitle} tabIndex={-1} id="home-title" className="text-[28px] leading-tight font-semibold tracking-tight outline-none">Productos</h1><p className="font-mono text-xs text-subtle-foreground">Tu radar de precios</p></div>
      <Button variant="outline" size="sm" disabled={loading || props.sessionBusy} onClick={() => setRefresh(value => value + 1)}><RefreshCw aria-hidden="true" />Actualizar productos</Button>
    </div>
    {productsError && <Notice role="alert" className="mb-4">{productsError}</Notice>}
    {props.sessionError && props.sessionError !== productsError && <Notice role="alert" className="mb-4">{props.sessionError}</Notice>}
    <p role="status" className={loading || !notice ? 'sr-only' : 'mb-4 flex items-center gap-2 rounded-xl border border-border-strong bg-elevated px-3.5 py-3 text-sm'}>{!loading && notice && <Check aria-hidden="true" className="size-4 shrink-0 text-good" strokeWidth={2.5} />}{loading ? 'Cargando tus productos…' : notice}</p>
    {<>
      {signals.length > 0 && <div role="group" aria-label="Filtros rápidos" className="mb-3 flex flex-wrap gap-2">
        {signals.map(signal => <Button key={signal.filter} size="sm" variant="outline" aria-pressed={filter === signal.filter} className="aria-pressed:border-foreground aria-pressed:bg-foreground aria-pressed:text-background" onClick={() => setFilter(filter === signal.filter ? 'all' : signal.filter)}>
          <span aria-hidden="true" className={cn('size-1.5 rounded-full', signal.dot)} />{signal.label}<span className="font-mono text-xs tabular-nums opacity-70">{signal.count}</span>
        </Button>)}
      </div>}
      <details className="group mb-4 rounded-xl border border-border bg-card px-3.5"><summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 text-sm font-medium [&::-webkit-details-marker]:hidden"><SlidersHorizontal aria-hidden="true" className="size-4 text-muted-foreground" />Filtrar y ordenar{filter !== 'all' ? <span className="text-warn"> · filtro activo</span> : ''}</summary><div className="grid min-w-0 grid-cols-1 gap-4 pt-1 pb-4 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
        <label className="min-w-0 text-[13px] font-medium" htmlFor="product-filter">Estado<select id="product-filter" className={selectClass} value={filter} onChange={event => setFilter(event.target.value as Filter)}><option value="all">Todos</option><option value="active">Activos</option><option value="paused">Pausados</option><option value="error">Con error</option><option value="pending_confirmation">Por confirmar</option><option value="stale">Precio desactualizado</option><option value="reached">Meta alcanzada</option></select></label>
        <label className="min-w-0 text-[13px] font-medium" htmlFor="product-sort">Orden<select id="product-sort" className={selectClass} value={sort} onChange={event => setSort(event.target.value as Sort)}><option value="recent">Más recientes</option><option value="name">Nombre: A–Z</option><option value="discount">Mayor bajada frente a referencia</option></select></label>

      </div></details>
      <p className="mb-3 text-xs text-subtle-foreground">Toca las tarjetas que representan el mismo producto y comparten moneda.</p>
    </>}
    {loading ? <div aria-hidden="true" className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">{[0, 1, 2, 3].map(key => <div key={key} className="space-y-3 rounded-xl border border-border bg-card p-4"><div className="flex gap-3"><Skeleton className="size-14" /><div className="flex-1 space-y-2"><Skeleton className="h-4 w-3/4" /><Skeleton className="h-3 w-1/3" /></div><Skeleton className="h-5 w-16" /></div><Skeleton className="h-1 w-full" /><div className="grid grid-cols-2 gap-2"><Skeleton className="h-9" /><Skeleton className="h-9" /></div></div>)}</div>
      : productsError ? <Button variant="outline" disabled={props.sessionBusy || basketBusy || groupBusy} onClick={() => setRefresh(value => value + 1)}>Reintentar consulta</Button>
        : visible.length+visibleGroups.length === 0 ? <EmptyState icon={<Package />} title={products.length ? 'No hay productos con este estado' : 'Tu catálogo espera tu próximo producto'} description={products.length ? 'Prueba otro filtro para ver tus productos.' : 'Añade una URL para empezar a seguir su precio.'} action={products.length ? <Button variant="outline" onClick={() => setFilter('all')}>Ver todos</Button> : <Button disabled={props.sessionBusy || basketBusy || groupBusy} onClick={() => navigate('add')}><Plus aria-hidden="true" />Añadir producto</Button>} />
            : <><p className="mb-3 font-mono text-xs text-subtle-foreground">{visible.length+visibleGroups.length} productos · {visibleGroups.length} grupos</p><div className="grid min-w-0 grid-cols-1 items-start gap-3 sm:grid-cols-2 xl:grid-cols-3">{visibleGroups.map(group=><GroupCard key={group.id} group={group} onOpen={()=>go({view:'group',id:group.id})}/>)}{visible.map(product => <div key={product.id} className="min-w-0" onDragOver={e=>{if(product.status!=='pending_confirmation')e.preventDefault();}} onDrop={e=>{e.preventDefault();const from=e.dataTransfer.getData('application/x-scrappy-product');const source=products.find(p=>p.id===from);if(source&&source.id!==product.id&&!groupedIds.has(source.id)&&source.currency===product.currency&&source.target_type&&product.target_type){setSelected([source.id,product.id]);go({view:'group-create',id:''});}else setNotice('Selecciona dos ofertas confirmadas de la misma moneda.');}}>
              <ProductCard product={product} onDetail={() => go({ view: 'detail', id: product.id })} selection={product.status==='pending_confirmation'?undefined:{selected:selected.includes(product.id),onToggle:()=>setSelected(s=>s.includes(product.id)?s.filter(id=>id!==product.id):[...s,product.id]),onDragStart:e=>e.dataTransfer.setData('application/x-scrappy-product',product.id)}} /></div>)}</div></>}
    {selected.length>0&&view==='home'&&<div className="fixed inset-x-4 bottom-24 z-30 mx-auto grid max-w-xl grid-cols-2 items-center gap-2 rounded-xl border border-border-strong bg-elevated/95 p-3 backdrop-blur sm:flex lg:bottom-6">
      <div className="col-span-2 min-w-0 sm:flex-1"><p className="text-sm font-medium">{selected.length} {selected.length===1?'tarjeta seleccionada':'tarjetas seleccionadas'}</p><p className="hidden text-xs text-subtle-foreground sm:block">Elige el mismo producto en la misma moneda.</p></div>
      <Button className="w-full sm:w-auto" variant="outline" onClick={()=>setSelected([])}>Cancelar</Button><Button className="w-full sm:w-auto" disabled={!compatible||loading||!!productsError} onClick={()=>go({view:'group-create',id:''})}>Continuar <span aria-hidden="true">→</span></Button>
    </div>}
  </section>;

  const currentSection = view === 'lists' || view === 'basket-detail' ? 'lists' : view === 'settings' ? 'settings' : view === 'add' ? 'add' : 'home';
  return <div className="w-full flex-1 px-4 pt-3 pb-28 sm:px-6 lg:px-8 lg:pt-8 lg:pb-8">
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-4 lg:max-w-screen-2xl lg:flex-row lg:gap-10">
      <aside inert={pendingNavigation !== null} aria-label="Navegación de Scrappy" className="w-full shrink-0 lg:sticky lg:top-8 lg:w-56 lg:self-start">
        <div className="flex items-center justify-between gap-2 lg:hidden">
          <Logo />
          <div className="flex items-center gap-2">
          {view === 'home' && !mobileNavOpen && <Button size="sm" disabled={props.sessionBusy || basketBusy || groupBusy} onClick={() => navigate('add')}><Plus aria-hidden="true" />Añadir producto</Button>}
          <Button variant="ghost" size="sm" aria-expanded={mobileNavOpen} aria-controls="app-navigation" onClick={() => setMobileNavOpen(value => !value)}>
            <svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d={mobileNavOpen ? 'M18 6 6 18M6 6l12 12' : 'M4 6h16M4 12h16M4 18h16'} /></svg>
            {mobileNavOpen ? 'Cerrar' : 'Menú'}
          </Button>
          </div>
        </div>
        <Logo className="hidden lg:mb-8 lg:flex" />
        <div id="app-navigation" className={mobileNavOpen ? 'mt-3 space-y-4 rounded-xl border border-border bg-card p-3 lg:mt-0 lg:space-y-6 lg:border-0 lg:bg-transparent lg:p-0' : 'hidden lg:block lg:space-y-6'}>
          <div>
            <p className="mb-1.5 px-3 font-mono text-xs text-subtle-foreground">Seguimiento</p>
            <nav aria-label="Navegación principal" className="grid gap-0.5">
              <Button variant="nav" aria-current={currentSection === 'home' ? 'page' : undefined} disabled={props.sessionBusy || basketBusy || groupBusy} onClick={() => navigate('home')}>Productos</Button>
              <Button variant="nav" aria-label="Gestionar canastas" aria-current={currentSection === 'lists' ? 'page' : undefined} disabled={props.sessionBusy || basketBusy || groupBusy} onClick={() => navigate('lists')}>Canastas</Button>
            </nav>
          </div>
          <Button className="w-full" disabled={props.sessionBusy || basketBusy || groupBusy} onClick={() => navigate('add')}><Plus aria-hidden="true" />Añadir producto</Button>
          <div className="border-t border-border pt-4">
            <nav aria-label="Cuenta" className="grid gap-0.5">
              <Button variant="nav" aria-current={currentSection === 'settings' ? 'page' : undefined} disabled={props.sessionBusy || basketBusy || groupBusy} onClick={() => navigate('settings')}>Ajustes</Button>
              <Button variant="nav" disabled={props.sessionBusy || basketBusy || groupBusy} onClick={() => basketDirty ? setPendingNavigation('logout') : props.onLogout()}>{props.sessionBusy ? 'Cerrando sesión…' : 'Cerrar sesión'}</Button>
            </nav>
          </div>
        </div>
      </aside>
      <main inert={pendingNavigation !== null} className="min-w-0 flex-1 pt-2 lg:pt-0">{page}</main>
    </div>
    <nav inert={pendingNavigation !== null} aria-label="Secciones" className="fixed inset-x-0 bottom-0 z-20 grid grid-cols-3 border-t border-border bg-card/95 px-2 pt-1.5 pb-[max(0.75rem,env(safe-area-inset-bottom))] backdrop-blur lg:hidden">{([['home', 'Productos', Package], ['lists', 'Canastas', ShoppingBasket], ['settings', 'Ajustes', Settings]] as const).map(([target, label, Icon]) => <Button key={target} variant="ghost" className="min-h-13 flex-col gap-1 px-1 text-xs aria-[current=page]:font-semibold aria-[current=page]:text-foreground [&_svg]:size-5" aria-label={`Ir a ${label}`} aria-current={currentSection === target ? 'page' : undefined} disabled={props.sessionBusy || basketBusy || groupBusy} onClick={() => navigate(target)}><Icon aria-hidden="true" strokeWidth={currentSection === target ? 2.25 : 1.75} />{label}</Button>)}</nav>
    {pendingNavigation && <div className="fixed inset-0 z-50 flex items-end justify-center bg-background/80 p-4 backdrop-blur-sm sm:items-center"><section onKeyDown={event => {
      if (event.key === 'Escape') setPendingNavigation(null);
      if (event.key === 'Tab') { const buttons = event.currentTarget.querySelectorAll<HTMLButtonElement>('button'); const first = buttons[0], last = buttons[buttons.length - 1]; if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); } else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); } }
    }} role="alertdialog" aria-modal="true" aria-labelledby="leave-title" aria-describedby="leave-description" className="w-full max-w-md space-y-4 rounded-xl border border-border-strong bg-elevated p-5 sm:p-6"><h2 id="leave-title" className="text-[17px] font-semibold">Tienes cambios sin guardar</h2><p id="leave-description" className="text-sm text-muted-foreground">Si sales, perderás los cambios locales sin guardar. Las solicitudes ya enviadas no se cancelan.</p><div className="flex flex-wrap gap-3"><Button autoFocus onClick={() => setPendingNavigation(null)}>Seguir editando</Button><Button variant="outline" onClick={() => { const next = pendingNavigation; setPendingNavigation(null); setBasketDirty(false); if (next === 'logout') props.onLogout(); else completeNavigation(next); }}>Salir sin guardar</Button></div></section></div>}
  </div>;
}
