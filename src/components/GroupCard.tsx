import {bestGroupOffer,type ProductGroup} from '../lib/groups';
import {ProductThumbnail} from './ProductThumbnail';
import {formatPrice} from './ProductCard';
import {Button} from './ui/button';
export function GroupCard({group,onOpen}:{group:ProductGroup;onOpen:()=>void}) {
 const best=bestGroupOffer(group), image=group.offers.find(p=>p.id===group.image_product_id);
 return <article className="min-w-0 overflow-hidden rounded-2xl border border-primary/30 bg-card">
  <div className="flex h-40 items-center justify-center border-b border-border bg-muted/40 p-5"><ProductThumbnail key={image?.image_url} src={image?.image_url??null} alt={group.name} className="h-full w-full"/></div>
  <div className="space-y-5 p-5"><div><p className="mb-2 text-xs text-primary">{group.offers.length} ofertas · {group.paused?'Avisos pausados':'Meta compartida'}</p><h2 className="font-semibold [overflow-wrap:anywhere]">{group.name}</h2></div>
   <div><p className="text-xs text-muted-foreground">Más barata entre las opciones verificadas</p><p className="mt-2 text-2xl font-semibold tabular-nums">{formatPrice(best?.price??null,group.currency)}</p><p className="mt-1 text-xs text-muted-foreground">{best?.domain??'Sin ofertas válidas'}</p></div>
   <p className="text-sm">Meta común <span className="float-right font-medium">{formatPrice(group.target,group.currency)}</span></p>
   {group.offers.some(p=>p.excluded)&&<p className="text-xs text-muted-foreground">{group.offers.filter(p=>p.excluded).length} ofertas excluidas de la comparación actual.</p>}
   <Button className="w-full" variant="outline" onClick={onOpen}>Ver tiendas y gráfica</Button>
  </div>
 </article>;
}
