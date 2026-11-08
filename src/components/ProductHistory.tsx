import { CartesianGrid, Line, LineChart, ReferenceArea, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import type { ProductDetail } from '../lib/products';
import { productMetrics } from '../lib/products';
import { formatPrice } from './ProductCard';

export default function ProductHistory({ detail }: { detail: ProductDetail }) {
  const { product, history } = detail;
  const { target } = productMetrics(product);
  const date = (value: number) => new Intl.DateTimeFormat('es-PE', { day: 'numeric', month: 'short' }).format(value);
  return <ResponsiveContainer width="100%" height="100%" minWidth={0}>
    <LineChart data={history.map(point => ({ time: Date.parse(point.checked_at), price: point.price }))} margin={{ top: 18, right: 12, left: 0, bottom: 8 }} accessibilityLayer>
      <CartesianGrid stroke="var(--color-border)" vertical={false} />
      <XAxis dataKey="time" type="number" domain={['dataMin', 'dataMax']} tickFormatter={date} tick={{ fill: 'var(--color-subtle-foreground)', fontSize: 11, fontFamily: 'var(--font-mono)' }} tickLine={false} axisLine={{ stroke: 'var(--color-border)' }} minTickGap={35} />
      <YAxis width={56} domain={['auto', 'auto']} tick={{ fill: 'var(--color-subtle-foreground)', fontSize: 11, fontFamily: 'var(--font-mono)' }} tickLine={false} axisLine={false} tickFormatter={value => new Intl.NumberFormat('es-PE', { notation: 'compact' }).format(Number(value))} />
      <Tooltip labelFormatter={value => new Intl.DateTimeFormat('es-PE', { dateStyle: 'short', timeStyle: 'short' }).format(Number(value))}
        formatter={value => [formatPrice(Number(value), product.currency), 'Precio']} contentStyle={{ background: 'var(--color-elevated)', borderColor: 'var(--color-border-strong)', borderRadius: 10, fontSize: 13, fontVariantNumeric: 'tabular-nums' }} cursor={{ stroke: 'var(--color-border-strong)' }} />
      {product.reference_price !== null && <ReferenceLine y={product.reference_price} stroke="var(--color-subtle-foreground)" strokeDasharray="2 4" ifOverflow="extendDomain" label={{ value: 'Referencia', position: 'insideTopLeft', fill: 'var(--color-subtle-foreground)', fontSize: 11 }} />}
      {target !== null && <ReferenceArea y2={target} fill="var(--color-good)" fillOpacity={0.07} ifOverflow="extendDomain" />}
      {target !== null && <ReferenceLine y={target} stroke="var(--color-good)" strokeDasharray="5 4" ifOverflow="extendDomain" label={{ value: 'Meta', position: 'insideBottomLeft', fill: 'var(--color-good)', fontSize: 11 }} />}
      <Line type="linear" dataKey="price" stroke="var(--color-chart-1)" strokeWidth={2} dot={history.length < 15 ? { r: 2.5, fill: 'var(--color-chart-1)', strokeWidth: 0 } : false} activeDot={{ r: 4 }} isAnimationActive={false} />
    </LineChart>
  </ResponsiveContainer>;
}
