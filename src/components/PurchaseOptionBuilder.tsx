import { useEffect, useRef, useState } from 'react';
import type { Configuration } from '../lib/purchases';
import type { ProductSummary } from '../lib/products';
import { ProductThumbnail } from './ProductThumbnail';
import { Button } from './ui/button';
import { Input } from './ui/input';

const selectClass = 'mt-2 h-12 w-full min-w-0 rounded-lg border border-input bg-card px-3';

export function PurchaseOptionBuilder({ configuration: c, products, onChange, initialNeedIds = [], onComparisonDone, onAddProduct }: {
  configuration: Configuration;
  products: ProductSummary[];
  onChange: (c: Configuration) => void;
  initialNeedIds?: string[];
  onComparisonDone?: () => void;
  onAddProduct?: () => void;
}) {
  const [needId, setNeedId] = useState('');
  const [productId, setProductId] = useState('');
  const [content, setContent] = useState('1');
  const [count, setCount] = useState('1');
  const [reference, setReference] = useState(false);
  const [search, setSearch] = useState('');
  const [error, setError] = useState('');
  const dialog = useRef<HTMLDialogElement>(null);
  const requestedNeeds = initialNeedIds.join(',');
  const need = c.needs.find(n => n.id === (needId || initialNeedIds[0] || c.needs[0]?.id));
  const selectedProduct = products.find(p => p.id === productId);
  const visibleProducts = products.filter(p => `${p.name ?? ''} ${p.domain}`.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()));

  useEffect(() => {
    const element = dialog.current;
    if (requestedNeeds && element && !element.open) {
      if (typeof element.showModal === 'function') element.showModal();
      else element.setAttribute('open', '');
    }
  }, [requestedNeeds]);

  function close() {
    const element = dialog.current;
    if (element?.open) {
      if (typeof element.close === 'function') element.close();
      else { element.removeAttribute('open'); onComparisonDone?.(); }
    }
  }

  function open() {
    const element = dialog.current;
    if (!element || element.open) return;
    if (typeof element.showModal === 'function') element.showModal();
    else element.setAttribute('open', '');
  }

  function add() {
    const product = products.find(p => p.id === productId);
    if (!need || !product || !/^(?:0|[1-9]\d{0,11})(?:\.\d{1,6})?$/.test(content) || Number(content) <= 0 || !/^[1-9]\d{0,9}$/.test(count) || Number(count) > 2147483647) {
      setError('Elige un producto e indica cuánto contiene y cuántas unidades comprarías.'); return;
    }
    if (c.offers.some(o => o.product_id === product.id)) {
      setError('Este producto ya está en tus opciones. Puedes ajustar su presentación en «Más ajustes».'); return;
    }
    if (reference && c.alternatives.some(a => c.reference.includes(a.id) && a.scope.includes(need.id))) {
      setError('Tu compra de referencia ya cubre esta necesidad. Cambia la referencia en «Combos y preferencias» para evitar duplicarla.'); return;
    }
    const next = structuredClone(c), offerId = crypto.randomUUID(), alternativeId = crypto.randomUUID();
    next.offers.push({ id: offerId, product_id: product.id, max_purchase_units: null, coverage: [{ need_id: need.id, quantity: content }], extras: [] });
    next.alternatives.push({ id: alternativeId, name: product.name || product.domain,
      position: Math.max(-1, ...next.alternatives.map(a => a.position)) + 1, scope: [need.id], items: [{ offer_id: offerId, purchase_units: Number(count) }] });
    if (reference) next.reference.push(alternativeId);
    onChange(next);
    setProductId(''); setReference(false); setError('');
    close();
  }

  return <section aria-label="Opciones de compra" className="space-y-3">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div><h3 className="font-medium">Productos para comparar</h3><p className="text-sm text-muted-foreground">Elige una opción y cuántas unidades necesitas.</p></div>
      <Button type="button" onClick={() => { setNeedId(''); setError(''); open(); }}>+ Comparar producto</Button>
    </div>
    {!c.needs.length && <p className="text-sm text-muted-foreground">Añade primero lo que necesitas en «Qué necesitas».</p>}

    <dialog ref={dialog} aria-labelledby="compare-product-title" onCancel={e => { e.preventDefault(); close(); }} onClose={onComparisonDone}
      className="m-auto max-h-[88dvh] w-[min(94vw,42rem)] max-w-none overflow-y-auto rounded-2xl border border-border bg-card p-0 text-foreground shadow-2xl backdrop:bg-black/70">
      <div className="sticky top-0 z-10 flex items-start justify-between gap-4 border-b border-border bg-card p-5">
        <div><p className="text-xs font-medium uppercase tracking-wide text-primary">Nueva opción</p><h2 id="compare-product-title" className="mt-1 text-xl font-semibold">Elige con qué comparar</h2></div>
        <button type="button" onClick={close} aria-label="Cerrar" className="min-h-11 min-w-11 rounded-lg border border-border text-xl hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring">×</button>
      </div>
      <div className="space-y-5 p-5">
        {!c.needs.length ? <p className="text-sm">Primero añade una necesidad en el paso «Qué necesitas».</p> : <>
          {c.needs.length > 1 && <label className="block text-sm">Comparar para<select className={selectClass} value={need?.id ?? ''} onChange={e => { setNeedId(e.target.value); setProductId(''); setError(''); }}>{c.needs.map(n => <option key={n.id} value={n.id}>{n.name} · {formatQuantity(n.required_quantity)} {displayUnit(n.unit)}</option>)}</select></label>}
          {productId ? <>
            <div className="flex items-center gap-3 rounded-xl border border-primary/40 bg-primary/5 p-3">
              <ProductThumbnail src={selectedProduct?.image_url ?? null} alt="" className="size-16" />
              <div className="min-w-0 flex-1"><p className="font-medium [overflow-wrap:anywhere]">{selectedProduct?.name || selectedProduct?.domain}</p><p className="text-sm text-muted-foreground">{selectedProduct?.domain} · {productPrice(selectedProduct)}</p></div>
              <Button type="button" variant="outline" onClick={() => { setProductId(''); setError(''); }}>Cambiar</Button>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="text-sm">Contenido por envase ({displayUnit(need?.unit ?? 'unit')})<Input className="mt-2" inputMode="decimal" value={content} onChange={e => setContent(e.target.value.replace(',', '.'))} /></label>
              <label className="text-sm">Unidades a comprar<Input className="mt-2" inputMode="numeric" value={count} onChange={e => setCount(e.target.value)} /></label>
            </div>
            <p className="text-xs text-muted-foreground">La cantidad sirve para cubrir {need?.name}: {formatQuantity(need?.required_quantity ?? '1')} {displayUnit(need?.unit ?? 'unit')}. Scrappy compara el total de la compra con precios válidos de las tiendas.</p>
            <label className="flex min-h-11 items-center gap-3 text-sm"><input type="checkbox" checked={reference} onChange={e => setReference(e.target.checked)} />Tomar esta opción como mi compra de referencia</label>
            {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
            <div className="flex flex-wrap justify-end gap-2 border-t border-border pt-4"><Button type="button" variant="outline" onClick={close}>Cancelar</Button><Button type="button" disabled={c.offers.length >= 64 || c.alternatives.length >= 128} onClick={add}>Añadir al carrito</Button></div>
          </> : <>
            <label className="block text-sm">Buscar en tus productos<Input className="mt-2" type="search" placeholder="Nombre o tienda" value={search} onChange={e => setSearch(e.target.value)} /></label>
            <ul className="max-h-[42dvh] space-y-2 overflow-y-auto pr-1" aria-label="Productos disponibles para comparar">
              {visibleProducts.map(p => {
                const exists = c.offers.some(o => o.product_id === p.id);
                return <li key={p.id}><button type="button" disabled={exists} onClick={() => { setProductId(p.id); setError(''); }} className="flex min-h-20 w-full items-center gap-3 rounded-xl border border-border p-3 text-left transition-colors hover:border-primary/60 hover:bg-muted/50 focus-visible:outline-2 focus-visible:outline-ring disabled:cursor-not-allowed disabled:opacity-60">
                  <ProductThumbnail src={p.image_url} alt="" className="size-16" />
                  <span className="min-w-0 flex-1"><span className="block font-medium [overflow-wrap:anywhere]">{p.name || p.domain}</span><span className="mt-1 block text-sm text-muted-foreground">{p.domain} · {productPrice(p)}</span></span>
                  <span className="shrink-0 text-xs text-primary">{exists ? 'Ya añadido' : 'Elegir →'}</span>
                </button></li>;
              })}
              {!visibleProducts.length && <li className="rounded-lg border border-dashed border-border p-5 text-center text-sm text-muted-foreground">No hay productos que coincidan con la búsqueda.</li>}
            </ul>
            {onAddProduct && <Button type="button" variant="outline" onClick={() => { close(); onAddProduct(); }}>Añadir producto por enlace</Button>}
          </>}
        </>}
      </div>
    </dialog>
  </section>;
}

function productPrice(product: ProductSummary | undefined) {
  if (!product) return 'Sin precio';
  const status = ({ active: 'seguimiento activo', paused: 'seguimiento en pausa', pending_confirmation: 'lectura pendiente', error: 'última revisión con error' } as const)[product.status];
  if (product.last_price == null || !product.currency) return `Sin precio · ${status}`;
  const amount = product.last_price.toLocaleString('es-PE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${product.currency === 'PEN' ? 'S/' : product.currency} ${amount} · ${status}`;
}
function formatQuantity(value: string) { return new Intl.NumberFormat('es-PE', { maximumFractionDigits: 6 }).format(Number(value)); }
function displayUnit(value: string) { return value === 'unit' ? 'unidades' : value; }
