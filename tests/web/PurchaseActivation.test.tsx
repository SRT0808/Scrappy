import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { PurchaseActivation } from '../../src/components/PurchaseActivation';
import { publication } from '../../src/lib/purchases';
import { purchaseFixture, purchaseId } from '../fixtures/purchase-ui';

beforeEach(() => sessionStorage.clear());
function mount(mode: 'ok' | 'lost' | 'conflict' | 'empty' | 'expired' = 'ok') {
 const configuration=publication(purchaseFixture().configuration!);
 if(mode==='empty') Object.assign(configuration,{needs:[],offers:[],alternatives:[],pins:[],reference:[]});
 const preview={schema_version:2,list_id:purchaseId,version:'5',token:'a'.repeat(64),configuration};
 let receipt: unknown=null;
 const fetch=vi.fn(async(url:string, options?:RequestInit)=>{
  if(mode==='expired') return new Response('{}',{status:401});
  if(url==='/api/products') return Response.json({products:[]});
  if(options?.method==='POST') {
   const b=JSON.parse(String(options.body));
   if(mode==='conflict') return new Response('{}',{status:409});
   receipt={schema_version:2,list_id:purchaseId,request_id:b.request_id,previous_version:'5',version:'6',configuration:{...b.configuration,version:'6'}};
   if(mode==='lost') throw new Error('Lost after commit');
   return Response.json(receipt);
  }
  if(url.includes('request_id=')) return Response.json({schema_version:2,list_id:purchaseId,request_id:new URL(url,'https://local.test').searchParams.get('request_id'),receipt});
  return Response.json(preview);
 });
 vi.stubGlobal('fetch',fetch);
 const onActivated=vi.fn(),onExpired=vi.fn();
 const view=render(<PurchaseActivation id={purchaseId} onActivated={onActivated} onExpired={onExpired}/>);
 return {fetch,onActivated,onExpired,view};
}
async function confirm() {
 fireEvent.click(screen.getByRole('button',{name:'Preparar conversión'}));
 await screen.findByText(/Versión 5 → 6/);
 const submit=screen.getByRole('button',{name:'Confirmar activación de esta canasta'});
 expect(submit).toBeDisabled();
 fireEvent.change(screen.getByLabelText('Avisar presupuesto'),{target:{value:'no'}});
 fireEvent.change(screen.getByLabelText('Avisar cambio de ganador'),{target:{value:'yes'}});
 expect(submit).toBeDisabled();
 fireEvent.click(screen.getByRole('checkbox',{name:'Confirmo esta conversión y los avisos seleccionados'}));
 fireEvent.click(submit);
}
it('requires explicit notice choices and confirmation, sends one basket/version/token',async()=>{
 const {fetch,onActivated}=mount();await confirm();await waitFor(()=>expect(onActivated).toHaveBeenCalledOnce());
 const posts=fetch.mock.calls.filter(([,o])=>o?.method==='POST');expect(posts).toHaveLength(1);
 const body=JSON.parse(String(posts[0][1]?.body));
 expect(body).toMatchObject({schema_version:2,expected_version:'5',token:'a'.repeat(64),configuration:{budget_enabled:false,winner_enabled:true}});
 expect(sessionStorage.getItem(`scrappy.activation.${purchaseId}`)).toBeNull();
});
it('reconciles a lost successful response after remount, without a second mutation',async()=>{
 const {fetch,onActivated,view}=mount('lost');await confirm();
 await screen.findByRole('button',{name:'Consultar recibo de activación'});
 await waitFor(()=>expect(screen.getByRole('button',{name:'Consultar recibo de activación'})).toBeEnabled());
 expect(onActivated).not.toHaveBeenCalled();view.unmount();
 render(<PurchaseActivation id={purchaseId} onActivated={onActivated} onExpired={vi.fn()}/>);
 fireEvent.click(screen.getByRole('button',{name:'Consultar recibo de activación'}));
 await waitFor(()=>expect(onActivated).toHaveBeenCalledOnce());
 expect(fetch.mock.calls.filter(([,o])=>o?.method==='POST')).toHaveLength(1);
});
it('conflict locks mutation until authenticated receipt consultation and a fresh preview',async()=>{
 const {fetch,onActivated}=mount('conflict');await confirm();
 await screen.findByText(/La canasta cambió/);
 expect(screen.queryByRole('button',{name:'Confirmar activación de esta canasta'})).not.toBeInTheDocument();
 fireEvent.click(screen.getByRole('button',{name:'Consultar recibo de activación'}));
 await screen.findByText(/Todavía no hay recibo/);
 expect(onActivated).not.toHaveBeenCalled();expect(fetch.mock.calls.filter(([,o])=>o?.method==='POST')).toHaveLength(1);
 expect(screen.getByRole('button',{name:'Preparar conversión'})).toBeEnabled();
});
it('does not send an offline confirmation and preserves its reconciliation identity',async()=>{
 const {fetch}=mount();vi.spyOn(navigator,'onLine','get').mockReturnValueOnce(false);
 await confirm();await screen.findByText(/Sin conexión/);
 expect(fetch.mock.calls.filter(([,o])=>o?.method==='POST')).toHaveLength(0);
 expect(sessionStorage.getItem(`scrappy.activation.${purchaseId}`)).toBeTruthy();
});
it('requires an explicit empty-basket graph and resets confirmation when its draft changes',async()=>{
 const {fetch}=mount('empty');
 fireEvent.click(screen.getByRole('button',{name:'Preparar conversión'}));
 await screen.findByText(/Canasta vacía/);
 fireEvent.click(screen.getByRole('checkbox',{name:'Confirmo esta conversión y los avisos seleccionados'}));
 fireEvent.click(screen.getByRole('button',{name:'Añadir necesidad'}));
 expect(screen.getByRole('checkbox',{name:'Confirmo esta conversión y los avisos seleccionados'})).not.toBeChecked();
 expect(screen.getByLabelText('Nombre de necesidad 1')).toBeInTheDocument();
 expect(fetch.mock.calls.filter(([,o])=>o?.method==='POST')).toHaveLength(0);
});
it('reports an expired preview session without exposing a confirmation',async()=>{
 const {onExpired}=mount('expired');
 fireEvent.click(screen.getByRole('button',{name:'Preparar conversión'}));
 await waitFor(()=>expect(onExpired).toHaveBeenCalledWith('Tu sesión ha caducado.'));
 expect(screen.queryByRole('button',{name:'Confirmar activación de esta canasta'})).not.toBeInTheDocument();
});
