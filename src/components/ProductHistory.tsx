import { CartesianGrid, Line, LineChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
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
      <XAxis dataKey="time" type="number" domain={['dataMin', 'dataMax']} tickFormatter={date} tick={{ fill: 'var(--color-muted-foreground)', fontSize: 11 }} minTickGap={35} />
      <YAxis width={56} domain={['auto', 'auto']} tick={{ fill: 'var(--color-muted-foreground)', fontSize: 11 }} tickFormatter={value => new Intl.NumberFormat('es-PE', { notation: 'compact' }).format(Number(value))} />
      <Tooltip labelFormatter={value => new Intl.DateTimeFormat('es-PE', { dateStyle: 'short', timeStyle: 'short' }).format(Number(value))}
        formatter={value => [formatPrice(Number(value), product.currency), 'Precio']} contentStyle={{ background: 'var(--color-card)', borderColor: 'var(--color-border)', borderRadius: 12 }} />
      {product.reference_price !== null && <ReferenceLine y={product.reference_price} stroke="var(--color-muted-foreground)" strokeDasharray="4 4" ifOverflow="extendDomain" />}
      {target !== null && <ReferenceLine y={target} stroke="var(--color-primary)" strokeDasharray="4 4" ifOverflow="extendDomain" />}
      <Line type="linear" dataKey="price" stroke="var(--color-primary)" strokeWidth={2} dot={history.length < 15} isAnimationActive={false} />
    </LineChart>
  </ResponsiveContainer>;
}
