import { isProductGroup, type ProductGroup } from '../../lib/group-contract';
import { ProductsError } from './products';
export * from '../../lib/group-contract';
export async function groupRequest(id?: string, mutation?: {action:string;version?:number;data:object}, signal?:AbortSignal) {
 let response: Response;
 try {
  response = await fetch(`/api/product-groups${id ? `?id=${encodeURIComponent(id)}` : ''}`, {
   method:mutation ? 'POST':'GET',credentials:'same-origin',headers:mutation ? {'Content-Type':'application/json'} : {},
   ...(mutation ? {body:JSON.stringify(mutation)} : {}),signal:AbortSignal.any([AbortSignal.timeout(20_000),...(signal?[signal]:[])]),
  });
 } catch { throw new ProductsError(0,'No pudimos confirmar el resultado. Actualiza antes de volver a guardar.'); }
 if (!response.ok) throw new ProductsError(response.status, response.status===401 ? 'Tu sesión ha caducado.' : response.status===409
  ? 'Los datos cambiaron o la oferta está vinculada. Actualiza; para borrar una oferta, retírala primero del grupo.'
  : response.status===404 ? 'El grupo no está disponible. Vuelve a Productos y actualiza antes de crear.'
  : response.status===400 ? 'Revisa la presentación, moneda y meta.' : 'No pudimos consultar el grupo.');
 const data = await response.json();
 const groups: ProductGroup[] = mutation ? [data.group] : data.groups;
 if (!Array.isArray(groups) || !groups.every(isProductGroup) || id && groups.some(g => g.id!==id)) throw new ProductsError(0,'Respuesta de grupos no válida. Actualiza la consulta.');
 return groups;
}
