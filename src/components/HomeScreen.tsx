import { useEffect, useRef, useState } from 'react';
import { Button } from './ui/button';
import { AddProduct } from './AddProduct';
import { ListsScreen } from './ListsScreen';
import { ProductCard } from './ProductCard';
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
type Filter = 'all' | ProductSummary['status'] | 'reached';
type Sort = 'recent' | 'name' | 'discount';
const selectClass = 'mt-2 h-12 w-full min-w-0 rounded-lg border border-input bg-card px-3 text-sm focus-visible:outline-2 focus-visible:outline-ring';

export function HomeScreen(props: Props) {
  const [linkedGroup] = useState(() => {const ids=new URLSearchParams(window.location.search).getAll('group');return ids.length===1&&uuidPattern.test(ids[0])?ids[0].toLowerCase():'';});
  const [groups,setGroups]=useState<ProductGroup[]>([]);
  const [selected,setSelected]=useState<string[]>([]);
  const [selecting,setSelecting]=useState(false);
  const [groupBusy,setGroupBusy]=useState(false);
  const [offerGroup,setOfferGroup]=useState<ProductGroup|null>(null);
  const groupSaving=useRef(false);
  const creationId=useRef<string|null>(null);
  const [linkedBasket] = useState(() => {
    const ids = new URLSearchParams(window.location.search).getAll('basket');
    return ids.length === 1 && uuidPattern.test(ids[0]) ? ids[0].toLowerCase() : '';
  });
  const [view, setView] = useState<'home' | 'lists' | 'add' | 'detail' | 'settings' | 'basket-detail' | 'group' | 'group-create'>(linkedGroup ? 'group' : linkedBasket ? 'basket-detail' : 'home');
  const [detailId, setDetailId] = useState(linkedGroup || linkedBasket);
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
  const [pendingNavigation, setPendingNavigation] = useState<'home' | 'lists' | 'settings' | 'add' | 'logout' | null>(null);
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
      if (!controller.signal.aborted) {setProducts(rows);setGroups(groupRows);setSelected([]);}
    }).catch((failure: { status: number; message: string }) => {
      if (controller.signal.aborted) return;
      if (failure.status === 401) expired.current(failure.message);
      else setProductsError(failure.message);
    }).finally(() => { if (!controller.signal.aborted) setProductsBusy(false); });
    return () => controller.abort();
  }, [view, refresh]);

  function returnHome() {
    if (basketBusy || groupBusy) return;
    if (basketDirty) { setPendingNavigation('home'); return; }
    clearBasketLink();
    setView('home');
    setMobileNavOpen(false);
    setTimeout(() => homeTitle.current?.focus(), 0);
  }
  function navigate(next: 'home' | 'lists' | 'settings' | 'add') {
    if (basketBusy || groupBusy) return;
    if (basketDirty) { setPendingNavigation(next); return; }
    completeNavigation(next);
  }
  function completeNavigation(next: 'home' | 'lists' | 'settings' | 'add') {
    clearBasketLink();
    setMobileNavOpen(false);
    if (next === 'home') { setView('home'); return; }
    if (next === 'add') setNotice('');
    setView(next);
  }
  function clearBasketLink() {
    setOfferGroup(null);
    creationId.current = null;
    const url = new URL(window.location.href);
    url.searchParams.delete('basket');
    url.searchParams.delete('group');
    url.searchParams.delete('group_event');
    window.history.replaceState(window.history.state, '', url.pathname + url.search + url.hash);
  }

  const groupedIds=new Set(groups.flatMap(g=>g.offers.map(p=>p.id)));
  const visible = products.filter(product => !groupedIds.has(product.id) && (filter === 'all' || (filter === 'reached' ? productMetrics(product).reached : product.status === filter)))
    .sort((a, b) => sort === 'name' ? (a.name || a.domain).localeCompare(b.name || b.domain, 'es')
      : sort === 'discount' ? (productMetrics(a).variation ?? Infinity) - (productMetrics(b).variation ?? Infinity)
        : Date.parse(b.created_at) - Date.parse(a.created_at));
  const loading = productsBusy;
  const error = productsError || props.sessionError;
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
    try{await groupRequest(id,{action:'create',data:{...edit,same_product:true,product_ids:selectedOffers.map(p=>p.id)}});setDetailId(id);setView('group');setNotice('Grupo creado.');creationId.current=null;}
    catch(e){const p=e as {status:number;message:string};if(p.status===401)props.onExpired(p.message);else {setProductsError(p.message);if(p.status===0||p.status>=500||p.status===409){setDetailId(id);setView('group');}}}
    finally{groupSaving.current=false;setGroupBusy(false);}
  }
  const page = view === 'lists' ? <ListsScreen {...props} onDetail={(id, name) => { setDetailId(id); setBasketName(name ?? ''); setView('basket-detail'); }} showLogout={false} onHome={() => returnHome()} />
    : view==='group'?<GroupDetailScreen key={detailId} id={detailId} eventId={new URLSearchParams(window.location.search).get('group_event')??undefined} onBusyChange={setBasketBusy} onExpired={props.onExpired} onBack={returnHome} onOffer={(id,group)=>{clearBasketLink();setOfferGroup(group);setDetailId(id);setView('detail');}}/>
    : view==='group-create'&&compatible?<GroupEditor creating offers={selectedOffers.map(p=>({id:p.id,name:p.name||p.domain,currency:p.currency!,image_url:p.image_url,reference_price:p.reference_price!,target_type:p.target_type!,target_value:(p.target_type==='percent'?p.target_percent:p.target_price)??0,price:p.last_price,excluded:p.status==='active'&&p.last_success_at===p.last_checked_at?null:'Sin precio válido'}))} busy={groupBusy} error={error} onCancel={returnHome} onSave={edit=>void createGroup(edit)}/>
    : view === 'basket-detail' ? <PurchaseBasketScreen key={detailId} id={detailId} name={basketName || lists.find(l => l.id === detailId)?.name || 'Tu canasta'} onDirtyChange={setBasketDirty} onBusyChange={setBasketBusy} onExpired={props.onExpired} onBack={() => navigate('lists')} />
    : view === 'settings' ? <SettingsScreen onExpired={props.onExpired} onBack={() => returnHome()} />
      : view === 'detail' ? <ProductDetailScreen group={offerGroup?.offers.some(p=>p.id===detailId)?offerGroup:undefined} onGroup={()=>{if(offerGroup){setDetailId(offerGroup.id);setView('group');}}} key={detailId} id={detailId} lists={lists} onExpired={props.onExpired} onBack={() => returnHome()} onDeleted={() => { setNotice('Producto e historial eliminados.'); returnHome(); }} />
        : view === 'add' ? <AddProduct lists={lists} onExpired={props.onExpired} onCloseLabel="Volver a Inicio" onClose={returnHome} onSaved={() => { setNotice('Producto guardado y activo.'); returnHome(); }} />
          : <section aria-labelledby="home-title" className="mx-auto w-full min-w-0 self-start">
    <div className="mb-7 flex flex-wrap items-start justify-between gap-4">
      <div><p className="mb-2 text-xs font-medium tracking-[0.16em] text-primary uppercase">Tu radar de precios</p><h1 ref={homeTitle} tabIndex={-1} id="home-title" className="text-3xl font-semibold tracking-tight outline-none">Productos</h1></div>
      {!mobileNavOpen && <Button className="lg:hidden" disabled={props.sessionBusy || basketBusy || groupBusy} onClick={() => navigate('add')}>Añadir producto</Button>}
    </div>
    {error && <p role="alert" className="mb-4 text-sm leading-relaxed text-destructive">{error}</p>}
    <p role="status" className="mb-4 text-sm text-primary">{loading ? 'Cargando tus productos…' : notice}</p>
    {<>
      <details className="mb-3 rounded-xl border border-border p-3"><summary className="cursor-pointer py-2 text-sm font-medium">Filtrar y ordenar{filter !== 'all' ? ' · filtro activo' : ''}</summary><div className="mt-3 grid min-w-0 grid-cols-1 gap-4 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
        <label className="min-w-0 text-sm text-muted-foreground" htmlFor="product-filter">Estado<select id="product-filter" className={selectClass} value={filter} onChange={event => setFilter(event.target.value as Filter)}><option value="all">Todos</option><option value="active">Activos</option><option value="paused">Pausados</option><option value="error">Con error</option><option value="pending_confirmation">Por confirmar</option><option value="reached">Meta alcanzada</option></select></label>
        <label className="min-w-0 text-sm text-muted-foreground" htmlFor="product-sort">Orden<select id="product-sort" className={selectClass} value={sort} onChange={event => setSort(event.target.value as Sort)}><option value="recent">Más recientes</option><option value="name">Nombre: A–Z</option><option value="discount">Mayor bajada frente a referencia</option></select></label>

      </div></details>
      <Button className="mb-5" variant="outline" disabled={loading || props.sessionBusy} onClick={() => setRefresh(value => value + 1)}>Actualizar productos</Button>
      <div className="mb-5 flex flex-wrap items-center gap-3"><Button variant="outline" disabled={loading||!!error} aria-pressed={selecting} onClick={()=>{setSelecting(!selecting);setSelected([]);}}>{selecting?'Cancelar selección':'Seleccionar para agrupar'}</Button>{selecting&&<><Button disabled={!compatible} onClick={()=>setView('group-create')}>Agrupar ({selected.length})</Button><p className="text-xs text-muted-foreground">Selecciona al menos dos ofertas idénticas en la misma moneda. También puedes arrastrar el control de una oferta sobre otra.</p></>}</div>
    </>}
    {loading ? <div aria-hidden="true" className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3">{[0, 1, 2].map(key => <div key={key} className="h-96 rounded-2xl border border-border bg-card motion-safe:animate-pulse" />)}</div>
      : error ? <Button variant="outline" disabled={props.sessionBusy || basketBusy || groupBusy} onClick={() => setRefresh(value => value + 1)}>Reintentar consulta</Button>
        : visible.length+visibleGroups.length === 0 ? <div className="rounded-2xl border border-dashed border-border p-8 text-center"><h2 className="font-semibold">{products.length ? 'No hay productos con este estado' : 'Tu catálogo espera tu próximo producto'}</h2><p className="mt-3 text-sm text-muted-foreground">{products.length ? 'Prueba otro filtro para ver tus productos.' : 'Añade una URL para empezar a seguir su precio.'}</p></div>
            : <><p className="mb-4 text-sm text-muted-foreground">{visible.length+visibleGroups.length} productos · {visibleGroups.length} grupos</p><div className="grid min-w-0 grid-cols-1 items-start gap-5 sm:grid-cols-2 lg:grid-cols-3">{visibleGroups.map(group=><GroupCard key={group.id} group={group} onOpen={()=>{setDetailId(group.id);setView('group');}}/>)}{visible.map(product => <div key={product.id} className="min-w-0" onDragOver={e=>{if(product.status!=='pending_confirmation')e.preventDefault();}} onDrop={e=>{e.preventDefault();const from=e.dataTransfer.getData('application/x-scrappy-product');const source=products.find(p=>p.id===from);if(source&&source.id!==product.id&&!groupedIds.has(source.id)&&source.currency===product.currency&&source.target_type&&product.target_type){setSelected([source.id,product.id]);setView('group-create');}else setNotice('Selecciona dos ofertas confirmadas de la misma moneda.');}}>
              {product.status!=='pending_confirmation'&&<div className="mb-2 flex items-center gap-3">{selecting&&<label className="flex min-w-0 items-center gap-2 text-sm"><input type="checkbox" checked={selected.includes(product.id)} onChange={e=>setSelected(e.target.checked?[...selected,product.id]:selected.filter(id=>id!==product.id))}/>Seleccionar {product.name||product.domain}</label>}<button type="button" draggable onDragStart={e=>e.dataTransfer.setData('application/x-scrappy-product',product.id)} className="ml-auto min-h-11 cursor-grab rounded-lg border border-border px-3 text-xs text-muted-foreground" aria-label={`Arrastrar para agrupar ${product.name||product.domain}`} onClick={()=>{setSelecting(true);setSelected(s=>s.includes(product.id)?s:[...s,product.id]);}}>⠿ Agrupar</button></div>}
              <ProductCard product={product} onDetail={() => { setDetailId(product.id); setView('detail'); }} /></div>)}</div></>}
  </section>;

  const currentSection = view === 'lists' || view === 'basket-detail' ? 'lists' : view === 'settings' ? 'settings' : view === 'add' ? 'add' : 'home';
  const navButtonClass = (active: boolean) => `w-full justify-start ${active ? 'border-primary/50 bg-muted' : ''}`;
  return <div className="w-full flex-1 px-5 pt-5 pb-24 sm:pt-6 lg:pb-6">
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-5 lg:flex-row lg:gap-8">
      <aside inert={pendingNavigation !== null} aria-label="Navegación de Scrappy" className="w-full shrink-0 lg:w-56 lg:rounded-2xl lg:border lg:border-border lg:bg-card lg:p-4">
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
              <Button variant="outline" className={navButtonClass(currentSection === 'home')} aria-current={currentSection === 'home' ? 'page' : undefined} disabled={props.sessionBusy || basketBusy || groupBusy} onClick={() => navigate('home')}>Productos</Button>
              <Button variant="outline" className={navButtonClass(currentSection === 'lists')} aria-label="Gestionar canastas" aria-current={currentSection === 'lists' ? 'page' : undefined} disabled={props.sessionBusy || basketBusy || groupBusy} onClick={() => navigate('lists')}>Canastas</Button>
            </nav>
          </div>
          <Button className="w-full" disabled={props.sessionBusy || basketBusy || groupBusy} onClick={() => navigate('add')}>Añadir producto</Button>
          <div className="border-t border-border pt-4 lg:mt-8">
            <nav aria-label="Cuenta" className="grid gap-1">
              <Button variant="outline" className={navButtonClass(currentSection === 'settings')} aria-current={currentSection === 'settings' ? 'page' : undefined} disabled={props.sessionBusy || basketBusy || groupBusy} onClick={() => navigate('settings')}>Ajustes</Button>
              <Button variant="outline" className="w-full justify-start" disabled={props.sessionBusy || basketBusy || groupBusy} onClick={() => basketDirty ? setPendingNavigation('logout') : props.onLogout()}>{props.sessionBusy ? 'Cerrando sesión…' : 'Cerrar sesión'}</Button>
            </nav>
          </div>
        </div>
      </aside>
      <main inert={pendingNavigation !== null} className="min-w-0 flex-1 pt-1">{page}</main>
    </div>
    <nav inert={pendingNavigation !== null} aria-label="Secciones" className="fixed inset-x-0 bottom-0 z-20 flex justify-around border-t border-border bg-background px-2 pt-2 pb-[max(0.5rem,env(safe-area-inset-bottom))] lg:hidden">{([['home', 'Productos'], ['lists', 'Canastas'], ['settings', 'Ajustes']] as const).map(([target, label]) => <Button key={target} variant="outline" className={currentSection === target ? 'border-primary text-primary' : 'border-transparent'} aria-label={`Ir a ${label}`} aria-current={currentSection === target ? 'page' : undefined} disabled={props.sessionBusy || basketBusy || groupBusy} onClick={() => navigate(target)}>{label}</Button>)}</nav>
    {pendingNavigation && <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-5"><section onKeyDown={event => {
      if (event.key === 'Escape') setPendingNavigation(null);
      if (event.key === 'Tab') { const buttons = event.currentTarget.querySelectorAll<HTMLButtonElement>('button'); const first = buttons[0], last = buttons[buttons.length - 1]; if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); } else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); } }
    }} role="alertdialog" aria-modal="true" aria-labelledby="leave-title" aria-describedby="leave-description" className="w-full max-w-md space-y-4 rounded-2xl border border-border bg-card p-6"><h2 id="leave-title" className="text-xl font-semibold">Tienes cambios sin guardar</h2><p id="leave-description" className="text-sm text-muted-foreground">Si sales, perderás los cambios locales sin guardar. Las solicitudes ya enviadas no se cancelan.</p><div className="flex flex-wrap gap-3"><Button autoFocus onClick={() => setPendingNavigation(null)}>Seguir editando</Button><Button variant="outline" onClick={() => { const next = pendingNavigation; setPendingNavigation(null); setBasketDirty(false); if (next === 'logout') props.onLogout(); else completeNavigation(next); }}>Salir sin guardar</Button></div></section></div>}
  </div>;
}
