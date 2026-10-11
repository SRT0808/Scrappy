import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { basketStatistics } from '../../src/lib/baskets';
import { basketDetail, basketId, productId, snapshots } from '../fixtures/basket-experience';
import { BasketDetailScreen } from '../../src/components/BasketDetailScreen';
import { AddProduct } from '../../src/components/AddProduct';
vi.mock('../../src/components/BasketHistory',()=>({ default:()=> <div>Gráfico local</div> }));
const props={ onBack:vi.fn(),onExpired:vi.fn() };
const json=(body:unknown,status=200)=>new Response(JSON.stringify(body),{status});

describe('basket statistics',()=>{
  it('requires both thresholds and excludes estimates and other compositions',()=>{
    expect(basketStatistics(snapshots(9,14),2).eligible).toBe(false);
    expect(basketStatistics(snapshots(10,13.999),2).eligible).toBe(false);
    const points=[...snapshots(),...snapshots(10,30,1),{...snapshots()[0],complete:false,current_total:1}];
    expect(basketStatistics(points,2)).toMatchObject({eligible:true,count:10,days:14,average:104.5,median:104.5});
    points[0].complete=false;
    expect(basketStatistics(points,2).eligible).toBe(false);
  });
  it('never fills missing totals or empty history',()=>{
    expect(basketStatistics([],2).eligible).toBe(false);
    expect(basketStatistics(snapshots().map(s=>({...s,current_total:null})),2).count).toBe(0);
  });
});
describe('basket experience',()=>{
  it('segments history, provides ranges and blocks stale composition writes until refresh',async()=>{
    const fetch=vi.fn((url:string,options?:RequestInit)=>Promise.resolve(url==='/api/products' ? json({products:[]})
      : options?.method==='PATCH' ? json({},409) : json({detail:basketDetail})));
    vi.stubGlobal('fetch',fetch);render(<BasketDetailScreen id={basketId} {...props} />);
    await screen.findByText('Gasto objetivo alcanzado');
    expect(screen.getByText(/10 snapshots/)).toBeInTheDocument();
    expect(screen.getAllByText('S/ 104.50',{selector:'dd'})).toHaveLength(2);
    await userEvent.selectOptions(screen.getByLabelText('Composición'),'1');
    expect(screen.getByLabelText('Composición')).toHaveValue('1');
    await userEvent.click(screen.getByRole('button',{name:'14 días'}));
    await waitFor(()=>expect(fetch.mock.calls.some(([url])=>url.endsWith('range=14'))).toBe(true));
    await screen.findByText('Gasto objetivo alcanzado');
    fireEvent.change(screen.getByLabelText('Cantidad'),{target:{value:'3'}});
    await userEvent.click(screen.getByRole('button',{name:'Guardar cantidad'}));
    expect(await screen.findByRole('alert')).toHaveTextContent('composición cambió');
    expect(screen.getByRole('button',{name:'Quitar'})).toBeDisabled();
    const call=fetch.mock.calls.find(([,options])=>options?.method==='PATCH')!;
    expect(JSON.parse(String(call[1]?.body))).toEqual({product_id:productId,quantity:3,version:2});
    await userEvent.click(screen.getByRole('button',{name:'Actualizar canasta'}));
    await waitFor(()=>expect(screen.getByRole('button',{name:'Quitar'})).toBeEnabled());
  });
  it('marks missing and stale lines, keeps unknown totals and suppresses conclusions',async()=>{
    const detail={...basketDetail,snapshots:[...snapshots().slice(0,9),{...snapshots()[9],complete:false}],basket:{...basketDetail.basket,total:null,complete:false,valid_count:0,missing_count:1,lines:[{...basketDetail.basket.lines![0],last_price:null,stale:true,valid:false}]}};
    vi.stubGlobal('fetch',vi.fn((url:string)=>Promise.resolve(url==='/api/products'?json({products:[]}):json({detail}))));
    render(<BasketDetailScreen id={basketId} {...props}/>);
    await screen.findByText('Canasta incompleta');
    expect(screen.getByText(/al menos 14 días y 10/)).toBeInTheDocument();
    expect(screen.queryByText(/la mediana observada/)).not.toBeInTheDocument();
    expect(screen.getByText(/Precio desactualizado/)).toBeInTheDocument();
  });
});
describe('repair experience',()=>{
  it('uses the existing product ID and confirms extracted identity without replacing its goals',async()=>{
    const row={id:basketId,url:'https://shop.pe/repaired',status:'ready',product_id:null,created_at:'2026-10-11T00:00:00Z',result:{name:'Monitor nuevo enlace',price:'90.00',currency:'PEN',original_price:null,image_url:null,method:'json_ld',confidence:0.98,candidates:[],warnings:[]}};
    vi.spyOn(crypto,'randomUUID').mockReturnValue(basketId);
    const fetch=vi.fn().mockResolvedValueOnce(json({reading:row})).mockResolvedValueOnce(json({reading:{...row,status:'confirmed',product_id:productId}}));
    vi.stubGlobal('fetch',fetch);const saved=vi.fn();
    render(<AddProduct lists={[]} repair={{id:productId,name:'Monitor',currency:'PEN'}} onSaved={saved} onExpired={vi.fn()} onClose={vi.fn()}/>);
    fireEvent.change(screen.getByLabelText('URL del producto'),{target:{value:row.url}});
    await userEvent.click(screen.getByRole('button',{name:'Leer producto'}));
    await screen.findByRole('heading',{name:'Confirma lo que encontramos'});
    expect(screen.queryByLabelText('Precio de referencia')).not.toBeInTheDocument();
    expect(JSON.parse(fetch.mock.calls[0][1].body).repair_product_id).toBe(productId);
    await userEvent.click(screen.getByRole('checkbox'));
    await userEvent.click(screen.getByRole('button',{name:'Confirmar reparación'}));
    await waitFor(()=>expect(saved).toHaveBeenCalledWith(productId,''));
    expect(JSON.parse(fetch.mock.calls[1][1].body)).toEqual({action:'confirm_repair',candidate_index:null,name:row.result.name,currency:'PEN',same_product:true});
  });
  it('blocks a repair in a different currency',async()=>{
    vi.spyOn(crypto,'randomUUID').mockReturnValue(basketId);
    const fetch=vi.fn().mockResolvedValue(json({reading:{id:basketId,url:'https://shop.pe/new',status:'ready',product_id:null,created_at:'2026-10-11',result:{name:'Otro',price:'10.00',currency:'USD',original_price:null,image_url:null,method:'json_ld',confidence:0.98,candidates:[],warnings:[]}}}));
    vi.stubGlobal('fetch',fetch);
    render(<AddProduct lists={[]} repair={{id:productId,name:'Monitor',currency:'PEN'}} onSaved={vi.fn()} onExpired={vi.fn()} onClose={vi.fn()}/>);
    fireEvent.change(screen.getByLabelText('URL del producto'),{target:{value:'https://shop.pe/new'}});
    await userEvent.click(screen.getByRole('button',{name:'Leer producto'}));
    await screen.findByRole('heading',{name:'Confirma lo que encontramos'});
    await userEvent.click(screen.getByRole('checkbox'));
    await userEvent.click(screen.getByRole('button',{name:'Confirmar reparación'}));
    expect(screen.getByRole('alert')).toHaveTextContent('sin cambiar la moneda original');
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
