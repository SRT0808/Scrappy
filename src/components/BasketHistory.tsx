import { CartesianGrid, Line, LineChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import type { Snapshot } from '../lib/baskets';

export default function BasketHistory({ points, budget }: { points: Snapshot[]; budget: number | null }) {
  return <ResponsiveContainer width="100%" height="100%" minWidth={0}>
    <LineChart accessibilityLayer data={points.map(p => ({ time: Date.parse(p.calculated_at), reference: p.reference_total,
      current: p.complete ? p.current_total : null, estimated: p.complete ? null : p.current_total }))} margin={{ top: 15, right: 12, left: 0, bottom: 8 }}>
      <CartesianGrid stroke="var(--color-border)" vertical={false} />
      <XAxis dataKey="time" type="number" domain={['dataMin','dataMax']} tickFormatter={n => new Date(n).toLocaleDateString('es-PE')} minTickGap={40} tick={{ fill: 'var(--color-muted-foreground)', fontSize: 11 }} />
      <YAxis width={50} tick={{ fill: 'var(--color-muted-foreground)', fontSize: 11 }} />
      <Tooltip labelFormatter={n => new Date(Number(n)).toLocaleString('es-PE')} contentStyle={{ background: 'var(--color-card)', borderColor: 'var(--color-border)' }} />
      <Line name="Referencia" dataKey="reference" stroke="var(--color-muted-foreground)" strokeDasharray="4 4" isAnimationActive={false} />
      <Line name="Total completo" dataKey="current" stroke="var(--color-primary)" strokeWidth={2} connectNulls={false} isAnimationActive={false} />
      <Line name="Estimado" dataKey="estimated" stroke="#fbbf24" strokeDasharray="3 3" connectNulls={false} isAnimationActive={false} />
      {budget !== null && <ReferenceLine y={budget} stroke="var(--color-primary)" strokeDasharray="6 4" ifOverflow="extendDomain" />}
    </LineChart>
  </ResponsiveContainer>;
}
