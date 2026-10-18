import { localReadings } from './local-readings.js';
import { purchaseWorker } from '../lib/server/purchase-worker.js';

// Explicit opt-in only; Vite does not import this composition. No startup sweep.
// Runtime credentials and transports must be supplied by the authorized caller.
export function localPurchaseRuntime(root: string, options: Parameters<typeof purchaseWorker>[0]) {
  const worker = purchaseWorker(options);
  const executor = localReadings(root, { afterProductReview: worker.afterProductReview });
  return { ...executor, recover: worker.recover };
}
