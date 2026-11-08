import {useState} from 'react';
import {CartesianGrid,Line,LineChart,ReferenceLine,ResponsiveContainer,Tooltip,XAxis,YAxis} from 'recharts';
import type {ProductGroup} from '../lib/groups';
import {formatPrice} from './ProductCard';
import {Button} from './ui/button';
const colors=[1,2,3,4,5,6].map(n=>`var(--color-chart-${n})`);
export default function GroupHistory({group}:{group:ProductGroup}) {
 const [hidden,setHidden]=useState<string[]>([]),[range,setRange]=useState('all');
 const cutoff=range==='all'?-Infinity:Date.now()-Number(range)*86400000;
 const series=group.offers.filter(p=>!hidden.includes(p.id)).map(p=>({...p,history:p.history.filter(h=>Date.parse(h.time)>=cutoff)}));
 const times=series.flatMap(p=>p.history.map(h=>Date.parse(h.time)));
 return <section className="min-w-0 rounded-xl border border-border bg-card p-4 sm:p-6"><h2 className="text-[17px] font-semibold">Historial por tienda</h2>
  <div className="my-4 flex flex-wrap gap-2" aria-label="Rango del grupo">{['7','30','90','all'].map(r=><Button key={r} size="sm" variant={range===r?'default':'outline'} aria-pressed={range===r} onClick={()=>setRange(r)}>{r==='all'?'Todo':`${r} días`}</Button>)}</div>
  <div className="flex flex-wrap gap-3">{group.offers.map((p,i)=><label key={p.id} className="flex min-w-0 items-center gap-2 text-sm [overflow-wrap:anywhere]"><input type="checkbox" checked={!hidden.includes(p.id)} onChange={e=>setHidden(e.target.checked?hidden.filter(id=>id!==p.id):[...hidden,p.id])}/><span style={{color:colors[i%colors.length]}}>{p.domain} · {p.id.slice(0,6)}</span></label>)}</div>
  {times.length?<div role="img" aria-label="Historial de cada tienda y meta común actual" className="mt-5 h-72 min-w-0"><ResponsiveContainer width="100%" height="100%" minWidth={0}><LineChart margin={{top:12,right:12,bottom:8,left:0}} accessibilityLayer>
   <CartesianGrid stroke="var(--color-border)" vertical={false}/><XAxis dataKey="time" type="number" domain={[times.reduce((a,b)=>Math.min(a,b),Infinity),times.reduce((a,b)=>Math.max(a,b),-Infinity)]} tickFormatter={v=>new Date(v).toLocaleDateString('es-PE',{day:'numeric',month:'short'})} tick={{ fill: 'var(--color-subtle-foreground)', fontSize: 11, fontFamily: 'var(--font-mono)' }} tickLine={false} minTickGap={40}/><YAxis width={55} domain={['auto','auto']} tick={{ fill: 'var(--color-subtle-foreground)', fontSize: 11, fontFamily: 'var(--font-mono)' }} tickLine={false} axisLine={false}/>
   <Tooltip labelFormatter={v=>new Date(Number(v)).toLocaleString('es-PE')} formatter={(v,name)=>[formatPrice(Number(v),group.currency),name]} contentStyle={{ background: 'var(--color-elevated)', borderColor: 'var(--color-border-strong)', borderRadius: 10, fontSize: 13, fontVariantNumeric: 'tabular-nums' }}/>
   <ReferenceLine y={group.target} stroke="var(--color-good)" strokeDasharray="5 4" ifOverflow="extendDomain"/>
   {series.map(p=>{const index=group.offers.findIndex(o=>o.id===p.id);return <Line key={p.id} data={p.history.map(h=>({time:Date.parse(h.time),price:h.price}))} name={`${p.domain} · oferta ${index+1}`} dataKey="price" type="linear" stroke={colors[index%colors.length]} strokeDasharray={index<colors.length?undefined:`${2+Math.floor(index/colors.length)*2} 3`} dot={p.history.length<15} connectNulls={false} isAnimationActive={false}/>;})}</LineChart></ResponsiveContainer></div>:<p className="py-8 text-sm text-muted-foreground">Sin lecturas para las tiendas y el rango seleccionados.</p>}
  <p className="mt-4 text-xs leading-relaxed text-subtle-foreground">Cada línea conserva su historial anterior al grupo. Los fallos cortan la línea; no son precios cero. La línea discontinua muestra la meta actual, no metas históricas.</p>
 </section>;
}
