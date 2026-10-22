import { json } from '../lib/server/auth.js';
import { productDatabase, productsHandler } from '../lib/server/products.js';
import { uuidPattern } from '../lib/product-contract.js';
import { isProductGroup, validGroupEdit } from '../lib/group-contract.js';

export default productsHandler(['GET','POST'], async (req,res) => {
 const params = new URL(req.url ?? '', 'https://scrappy.local').searchParams;
 const id = params.get('id');
 if ([...params.keys()].some(k => k !== 'id') || params.getAll('id').length > 1 || id !== null && !uuidPattern.test(id)) {
  json(res,400,{error:'Indica un grupo válido.'}); return;
 }
 if (req.method === 'GET') {
  const groups = await productDatabase('rpc/read_product_groups',{p_id:id,p_history:!!id});
  if (!Array.isArray(groups) || !groups.every(isProductGroup)) throw new Error('Invalid group response');
  if (id && !groups.length) { json(res,404,{error:'El grupo ya no existe.'}); return; }
  json(res,200,{groups}); return;
 }
 const b = req.body as Record<string,unknown> | undefined;
 const action = b?.action;
 const data = b?.data as Record<string,unknown> | undefined;
 if (!id || !b || Object.keys(b).some(k => !['action','version','data'].includes(k))
  || !['create','edit','add','remove','dissolve','pause'].includes(String(action))
  || !data || typeof data !== 'object' || Array.isArray(data)
  || (action !== 'create' && (!Number.isSafeInteger(b.version) || Number(b.version) <= 0))) {
  json(res,400,{error:'Revisa los datos del grupo.'}); return;
 }
 const allowed: Record<string,string[]> = {
  create:['name','reference_price','target_type','target_value','image_product_id','same_product','product_ids'],
  edit:['name','reference_price','target_type','target_value','image_product_id'],
  add:['product_id','same_product'],remove:['product_id'],dissolve:[],pause:['paused'],
 };
 let valid = Object.keys(data).every(k => allowed[String(action)].includes(k));
 if (action === 'create' || action === 'edit') valid &&= validGroupEdit({ ...data });
 if (action === 'create') valid &&= data.same_product === true && Array.isArray(data.product_ids)
  && data.product_ids.length >= 2 && data.product_ids.length <= 50 && new Set(data.product_ids).size === data.product_ids.length
  && data.product_ids.every(p => typeof p === 'string' && uuidPattern.test(p)) && data.product_ids.includes(data.image_product_id);
 if (action === 'add' || action === 'remove') valid &&= typeof data.product_id === 'string' && uuidPattern.test(data.product_id);
 if (action === 'add') valid &&= data.same_product === true;
 if (action === 'pause') valid &&= typeof data.paused === 'boolean';
 if (!valid) { json(res,400,{error:'Confirma la presentación, moneda y meta del grupo.'}); return; }
 const group = await productDatabase('rpc/mutate_product_group',{p_id:id,p_version:b.version ?? null,p_action:action,p_body:data});
 if (!isProductGroup(group)) throw new Error('Invalid group response');
 json(res,200,{group});
});
