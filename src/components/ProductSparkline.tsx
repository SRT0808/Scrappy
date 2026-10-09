import { Line, LineChart, YAxis } from 'recharts';
import type { ProductSummary } from '../lib/products';

export default function ProductSparkline({ history }: { history: ProductSummary['history'] }) {
  return <LineChart responsive style={{ width: '100%', height: '100%' }} data={history} accessibilityLayer={false} margin={{ top: 4, bottom: 4, left: 4, right: 4 }}>
    <YAxis hide domain={['dataMin', 'dataMax']} />
    <Line type="linear" dataKey="price" stroke="var(--color-primary)" strokeWidth={2} dot={false} isAnimationActive={false} />
  </LineChart>;
}
