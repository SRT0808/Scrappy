import { CartesianGrid, Line, LineChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import type { Snapshot } from '../lib/baskets';

export default function BasketHistory({ points, budget }: { points: Snapshot[]; budget: number | null }) {
  return <ResponsiveContainer width="100%" height="100%" minWidth={0}>
    <LineChart accessibilityLayer data={points.map(p => ({ time: Date.parse(p.calculated_at), reference: p.reference_total,
      current: p.complete ? p.current_total : null, estimated: p.complete ? null : p.current_total }))} margin={{ top: 15, right: 12, left: 0, bottom: 8 }}>
      <CartesianGrid stroke="var(--color-border)" vertical={false} />
      <XAxis dataKey="time" type="number" domain={['dataMin','dataMax']} tickFormatter={n => new Date(n).toLocaleDateString('es-PE')} minTickGap={40} tick={{ fill: 'var(--color-subtle-foreground)', fontSize: 11, fontFamily: 'var(--font-mono)' }} tickLine={false} axisLine={{ stroke: 'var(--color-border)' }} />
      <YAxis width={50} tick={{ fill: 'var(--color-subtle-foreground)', fontSize: 11, fontFamily: 'var(--font-mono)' }} tickLine={false} axisLine={false} />
      <Tooltip labelFormatter={n => new Date(Number(n)).toLocaleString('es-PE')} contentStyle={{ background: 'var(--color-elevated)', borderColor: 'var(--color-border-strong)', borderRadius: 10, fontSize: 13, fontVariantNumeric: 'tabular-nums' }} />
      <Line name="Referencia" dataKey="reference" stroke="var(--color-subtle-foreground)" strokeDasharray="2 4" dot={false} isAnimationActive={false} />
      <Line name="Total completo" dataKey="current" stroke="var(--color-chart-1)" strokeWidth={2} dot={false} connectNulls={false} isAnimationActive={false} />
      <Line name="Estimado" dataKey="estimated" stroke="var(--color-warn)" strokeWidth={2} strokeDasharray="1 4" strokeLinecap="round" dot={false} connectNulls={false} isAnimationActive={false} />
      {budget !== null && <ReferenceLine y={budget} stroke="var(--color-good)" strokeDasharray="5 4" ifOverflow="extendDomain" />}
    </LineChart>
  </ResponsiveContainer>;
}
