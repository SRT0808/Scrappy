import { useState, type FormEvent } from 'react';
import { groupEditTarget, validGroupEdit, type GroupEdit } from '../lib/groups';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { formatPrice } from './ProductCard';
type Base = {id:string;name:string;currency:string;image_url:string|null;reference_price:number;target_type:'price'|'percent';target_value:number;price:number|null;excluded:string|null};
export function GroupEditor({offers,initial,busy,error,creating,onSave,onCancel}:{offers:Base[];initial?:GroupEdit;busy:boolean;error:string;creating?:boolean;onSave:(edit:GroupEdit)=>void;onCancel:()=>void}) {
 const [base,setBase]=useState(offers[0]?.id ?? '');
 const fromOffer=(p:Base):GroupEdit=>({name:p.name,reference_price:String(p.reference_price),target_type:p.target_type,target_value:String(p.target_value),image_product_id:p.id});
 const [edit,setEdit]=useState<GroupEdit>(()=>initial ?? fromOffer(offers[0]));
 const [confirmed,setConfirmed]=useState(false);
 const valid=validGroupEdit(edit), target=valid ? groupEditTarget(edit) : null;
 const met=target!==null && offers.some(p=>!p.excluded && p.price!==null && p.price<=target);
 const field='mt-2 h-12 w-full min-w-0 rounded-lg border border-input bg-card px-3 text-sm';
 function save(event:FormEvent) {event.preventDefault();if(valid && (!creating||confirmed))onSave(edit);}
 return <form aria-label={creating?'Crear grupo':'Editar grupo'} onSubmit={save} className="space-y-5 rounded-2xl border border-border bg-card p-5 sm:p-6">
  <h2 className="text-xl font-semibold">{creating?'Un producto, varias tiendas':'Meta y presentación del grupo'}</h2>
  {creating && <><p className="text-sm text-muted-foreground">Confirma que todas las ofertas tienen la misma fórmula, presentación y cantidad. Los combos se comparan desde Canastas.</p>
   <label className="block text-sm">Usar como punto de partida<select className={field} value={base} disabled={busy} onChange={e=>{setBase(e.target.value);setEdit(fromOffer(offers.find(p=>p.id===e.target.value)!));}}>{offers.map(p=><option key={p.id} value={p.id}>{p.name} · {p.id.slice(0,6)}</option>)}</select></label></>}
  <label className="block text-sm">Nombre del grupo<Input className="mt-2" required maxLength={300} value={edit.name} disabled={busy} onChange={e=>setEdit({...edit,name:e.target.value})}/></label>
  <label className="block text-sm">Imagen de la oferta<select className={field} value={edit.image_product_id} disabled={busy} onChange={e=>setEdit({...edit,image_product_id:e.target.value})}>{offers.map(p=><option key={p.id} value={p.id}>{p.name} · {p.id.slice(0,6)}</option>)}</select></label>
  <div className="grid gap-5 sm:grid-cols-2"><label className="block min-w-0 text-sm">Referencia común ({offers[0].currency})<Input className="mt-2" inputMode="decimal" required value={edit.reference_price} disabled={busy} onChange={e=>setEdit({...edit,reference_price:e.target.value.replace(',','.')})}/></label>
  <label className="block min-w-0 text-sm">Definir meta como<select className={field} value={edit.target_type} disabled={busy} onChange={e=>setEdit({...edit,target_type:e.target.value as GroupEdit['target_type'],target_value:''})}><option value="price">Monto máximo</option><option value="percent">Descuento sobre referencia común</option></select></label></div>
  <label className="block text-sm">{edit.target_type==='price'?'Monto objetivo':'Descuento deseado (%)'}<Input className="mt-2" inputMode="decimal" required value={edit.target_value} disabled={busy} onChange={e=>setEdit({...edit,target_value:e.target.value.replace(',','.')})}/></label>
  <p className="text-sm text-primary">Meta común: {target===null?'Completa los datos':formatPrice(target,offers[0].currency)}{valid&&edit.target_type==='price'?` · ${((1-target!/Number(edit.reference_price))*100).toFixed(2)} % frente a referencia`:''}</p>
  <p className="text-sm text-muted-foreground">Al editar la referencia conservamos {edit.target_type==='percent'?'el porcentaje y recalculamos el monto':'el monto y recalculamos el porcentaje'}. Las metas individuales quedan guardadas para cuando separes las ofertas.</p>
  {met && <p className="rounded-xl border border-primary/40 p-3 text-sm">Una oferta ya cumple esta meta. Crear el grupo o cambiar el monto objetivo permite un aviso en la próxima evaluación programada.</p>}
  {creating&&<label className="flex items-start gap-3 text-sm"><input className="mt-1 size-5 shrink-0 accent-emerald-500" type="checkbox" checked={confirmed} disabled={busy} onChange={e=>setConfirmed(e.target.checked)}/>Confirmo que son exactamente el mismo producto, presentación y cantidad.</label>}
  {error&&<p role="alert" className="text-sm text-destructive">{error}</p>}
  <div className="flex flex-wrap gap-3"><Button disabled={busy||!valid||!!creating&&!confirmed}>{busy?'Guardando…':creating?'Crear grupo':'Guardar cambios'}</Button><Button type="button" variant="outline" disabled={busy} onClick={onCancel}>Cancelar</Button></div>
 </form>;
}
