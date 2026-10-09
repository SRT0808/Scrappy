import { isReading, type Confirmation, type Reading } from '../../lib/product-contract';
import { isProductSummary, type ProductSummary } from '../../lib/home-contract';
import { isProductDetail, type ProductDetail, type ProductEdit, type HistoryRange } from '../../lib/detail-contract';
export type { ProductDetail, ProductEdit, HistoryRange } from '../../lib/detail-contract';
export { productMetrics, type ProductSummary } from '../../lib/home-contract';
export { money, percentageTarget, productUrl, validConfirmation, type Reading, type Confirmation } from '../../lib/product-contract';

export class ProductsError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

export async function requestDetail(id: string, range: HistoryRange = '30', signal?: AbortSignal): Promise<ProductDetail> {
  const payload = await detailRequest(id, 'GET', undefined, range, signal);
  if (!isProductDetail(payload.detail) || payload.detail.product.id !== id) throw new ProductsError(0, 'La respuesta del detalle no es válida. Actualiza la consulta.');
  return payload.detail;
}

export async function productAction(id: string, action: 'edit' | 'pause' | 'resume' | 'delete' | 'review', edit?: ProductEdit) {
  const method = action === 'delete' ? 'DELETE' : action === 'review' ? 'POST' : 'PATCH';
  const body = action === 'edit' ? edit : action === 'review' ? { action: 'review' }
    : action === 'delete' ? undefined : { status: action === 'pause' ? 'paused' : 'active' };
  const payload = await detailRequest(id, method, body);
  if (payload[action === 'review' ? 'queued' : action === 'delete' ? 'deleted' : 'updated'] !== true)
    throw new ProductsError(0, 'No pudimos confirmar el resultado. Actualiza el detalle antes de reintentar.');
}

async function detailRequest(id: string, method: string, body?: unknown, range: HistoryRange = '30', signal?: AbortSignal) {
  let response: Response;
  try {
    response = await fetch(`/api/products/${encodeURIComponent(id)}?range=${range}`, { method, credentials: 'same-origin', cache: 'no-store',
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body),
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(20_000)]) : AbortSignal.timeout(20_000) });
  } catch { throw new ProductsError(0, 'Se perdió la conexión. Actualiza el detalle antes de reintentar la acción.'); }
  const messages: Record<number, string> = { 400: 'Revisa los datos del producto.', 401: 'Tu sesión ha caducado. Introduce tu clave para volver a entrar.',
    403: 'No se pudo validar la solicitud. Recarga la página.', 404: 'El producto o la lista ya no existe.', 409: 'Reanuda el producto antes de revisarlo.' };
  if (!response.ok) throw new ProductsError(response.status, messages[response.status] ?? 'El servicio no está disponible. Actualiza el detalle antes de reintentar.');
  try { return await response.json(); }
  catch { throw new ProductsError(0, 'No pudimos confirmar el resultado. Actualiza el detalle.'); }
}

export async function requestProducts(listId: string, signal?: AbortSignal): Promise<ProductSummary[]> {
  let response: Response;
  try {
    response = await fetch(`/api/products?list_id=${encodeURIComponent(listId)}`, {
      method: 'GET', credentials: 'same-origin', cache: 'no-store',
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000),
    });
  } catch { throw new ProductsError(0, 'No pudimos cargar los productos. Comprueba tu conexión y reintenta.'); }
  if (!response.ok) throw new ProductsError(response.status, response.status === 401
    ? 'Tu sesión ha caducado. Introduce tu clave para volver a entrar.'
    : 'No pudimos cargar los productos. Inténtalo de nuevo.');
  try {
    const payload = await response.json();
    if (!Array.isArray(payload?.products) || !payload.products.every((row: unknown) => isProductSummary(row) && row.list_id === listId)) throw new Error('Invalid products');
    return payload.products;
  } catch { throw new ProductsError(0, 'La respuesta de productos no es válida. Reintenta la consulta.'); }
}

export async function requestReading(id: string, body?: { action: 'read'; url: string; selector?: string } | ({ action: 'confirm' } & Confirmation), signal?: AbortSignal): Promise<Reading> {
  let response: Response;
  try {
    response = await fetch(`/api/products/readings?id=${encodeURIComponent(id)}`, {
      method: body ? 'POST' : 'GET', credentials: 'same-origin', cache: 'no-store',
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(20_000)]) : AbortSignal.timeout(20_000),
    });
  } catch { throw new ProductsError(0, 'Se perdió la conexión. Consulta la lectura para comprobar el resultado.'); }
  if (!response.ok) {
    const messages: Record<number, string> = {
      400: 'Revisa la URL, el selector y los datos de confirmación.',
      401: 'Tu sesión ha caducado. Introduce tu clave para volver a entrar.',
      403: 'No se pudo validar la solicitud. Recarga la página.',
      404: 'La lectura o lista ya no existe. Actualiza las listas o reintenta la lectura.',
      409: 'La lectura cambió o todavía no está lista. Consulta su estado.',
    };
    throw new ProductsError(response.status, messages[response.status] ?? 'El servicio no está disponible. Consulta la lectura antes de reintentar.');
  }
  try {
    const payload = await response.json();
    if (!isReading(payload?.reading) || payload.reading.id !== id) throw new Error('Invalid reading');
    return payload.reading;
  } catch { throw new ProductsError(0, 'No pudimos confirmar el resultado. Consulta la lectura antes de continuar.'); }
}
