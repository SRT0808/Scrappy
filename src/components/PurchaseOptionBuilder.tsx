import { useState } from 'react';
import type { Configuration } from '../lib/purchases';
import type { ProductSummary } from '../lib/products';
import { Button } from './ui/button';
import { Input } from './ui/input';

export function PurchaseOptionBuilder({ configuration: c, products, onChange }: {
  configuration: Configuration; products: ProductSummary[]; onChange: (c: Configuration) => void;
}) {
  const [needId, setNeedId] = useState('');
  const [productId, setProductId] = useState('');
  const [content, setContent] = useState('1');
  const [count, setCount] = useState('1');
  const [reference, setReference] = useState(false);
  const [error, setError] = useState('');
  const need = c.needs.find(n => n.id === (needId || c.needs[0]?.id));
  const selectClass = 'mt-2 h-12 w-full min-w-0 rounded-lg border border-input bg-card px-3';
  function add() {
    const product = products.find(p => p.id === productId);
    if (!need || !product || !/^(?:0|[1-9]\d{0,11})(?:\.\d{1,6})?$/.test(content) || Number(content) <= 0 || !/^[1-9]\d{0,9}$/.test(count) || Number(count) > 2147483647) {
      setError('Elige un producto e indica contenido positivo y un número entero de compras.'); return;
    }
    if (c.offers.some(o => o.product_id === product.id)) {
      setError('Este producto ya tiene una presentación. Puedes editarla en «Editar presentaciones, coberturas y extras» y reutilizarla en Combos y preferencias.'); return;
    }
    if (reference && c.alternatives.some(a => c.reference.includes(a.id) && a.scope.includes(need.id))) {
      setError('Tu referencia ya cubre esta necesidad. Cambia las opciones de referencia en Combos y preferencias para evitar duplicarla.'); return;
    }
    const next = structuredClone(c), offerId = crypto.randomUUID(), alternativeId = crypto.randomUUID();
    next.offers.push({ id: offerId, product_id: product.id, max_purchase_units: null, coverage: [{ need_id: need.id, quantity: content }], extras: [] });
    next.alternatives.push({ id: alternativeId, name: product.name || product.domain,
      position: Math.max(-1, ...next.alternatives.map(a => a.position)) + 1, scope: [need.id], items: [{ offer_id: offerId, purchase_units: Number(count) }] });
    if (reference) next.reference.push(alternativeId);
    onChange(next); setProductId(''); setReference(false); setError('');
  }
  return <section aria-label="Añadir una opción sencilla" className="space-y-4 rounded-xl border border-primary/30 bg-primary/5 p-4">
    <h3 className="font-medium">Añadir una opción sencilla</h3>
    <p className="text-sm text-muted-foreground">Elige el producto, cuánto contiene cada presentación y cuántas comprarías. Por ejemplo: dos botellas de 500 ml para cubrir 1000 ml.</p>
    {!c.needs.length ? <p className="text-sm">Primero añade lo que necesitas en el paso 1.</p> : <>
      <label className="block text-sm">Para qué necesidad<select className={selectClass} value={need?.id ?? ''} onChange={e => setNeedId(e.target.value)}>{c.needs.map(n => <option key={n.id} value={n.id}>{n.name}</option>)}</select></label>
      <label className="block text-sm">Producto que comprarías<select className={selectClass} value={productId} onChange={e => setProductId(e.target.value)}><option value="">Elige un producto</option>{products.map(p => <option key={p.id} value={p.id}>{p.name || p.domain} · {p.domain}</option>)}</select></label>
      <div className="grid gap-3 sm:grid-cols-2"><label className="text-sm">Contenido por presentación ({need?.unit === 'unit' ? 'unidades' : need?.unit})<Input className="mt-2" inputMode="decimal" value={content} onChange={e => setContent(e.target.value.replace(',', '.'))} /></label>
        <label className="text-sm">Cuántas comprarías<Input className="mt-2" inputMode="numeric" value={count} onChange={e => setCount(e.target.value)} /></label></div>
      <label className="flex min-h-11 items-center gap-3 text-sm"><input type="checkbox" checked={reference} onChange={e => setReference(e.target.checked)} />Incluir esta opción en mi compra de referencia</label>
      <p className="text-xs text-muted-foreground">La referencia debe cubrir la compra completa. Los sobrantes necesitan tu aceptación en el paso 1.</p>
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      <Button type="button" disabled={c.offers.length >= 64 || c.alternatives.length >= 128} onClick={add}>Añadir opción de compra</Button>
    </>}
  </section>;
}
