import { useEffect, useRef, useState } from 'react';
import { readPurchases, type PurchaseRead } from '../lib/purchases';
import type { Basket } from '../lib/baskets';
import { BasketSummary } from './BasketSummary';
import { PurchaseResults } from './PurchaseResults';

export function PurchaseSummary({ id, basket, onExpired }: { id: string; basket: Basket; onExpired: (message: string) => void }) {
  const [data, setData] = useState<PurchaseRead | null>(null);
  const [error, setError] = useState('');
  const expired = useRef(onExpired); expired.current = onExpired;
  useEffect(() => {
    const controller = new AbortController();
    setData(null);
    setError('');
    readPurchases(id, 0, controller.signal).then(d => { if (!controller.signal.aborted) setData(d); }).catch(e => {
      if (controller.signal.aborted) return;
      if (e.status === 401) expired.current(e.message);
      else setError('No pudimos consultar alternativas. Abre la canasta para actualizar.');
    });
    return () => controller.abort();
  }, [id, basket]);
  return data?.mode === 'legacy' ? <BasketSummary basket={basket} /> : data ? <PurchaseResults data={data} compact /> : <p className="mb-4 text-sm text-muted-foreground">{error || 'Consultando compra vigente…'}</p>;
}
