import { StrictMode } from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { HomeScreen } from '../../src/components/HomeScreen';
import { ProductCard } from '../../src/components/ProductCard';
import { productMetrics, requestProducts, type ProductSummary } from '../../src/lib/products';

const first = { id: '11111111-1111-4111-8111-111111111111', name: 'Tecnología', emoji: null, position: 0, created_at: '2026-10-09' };
const second = { ...first, id: '22222222-2222-4222-8222-222222222222', name: 'Hogar', position: 1 };
const product: ProductSummary = { id: '33333333-3333-4333-8333-333333333333', list_id: first.id,
  url: 'https://shop.pe/product', domain: 'shop.pe', name: 'Monitor', image_url: null, currency: 'PEN',
  reference_price: 100, target_type: 'percent', target_price: 80, target_percent: 20, last_price: 90,
  status: 'active', created_at: '2026-10-09T00:00:00Z', last_checked_at: '2026-10-09T12:00:00Z', last_success_at: '2026-10-09T12:00:00Z', history: [],
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
function mount(strict = false) {
  const onExpired = vi.fn();
  const element = <HomeScreen onExpired={onExpired} onLogout={vi.fn()} sessionBusy={false} sessionError="" />;
  render(strict ? <StrictMode>{element}</StrictMode> : element);
  return onExpired;
}
function mock(products: ProductSummary[] = [product], lists = [first, second]) {
  const fetch = vi.fn((url: string, _options?: RequestInit) => Promise.resolve(url === '/api/lists' ? json({ lists }) : json({ products })));
  vi.stubGlobal('fetch', fetch);
  return fetch;
}
describe('home screen', () => {
  it('shows prices, percentage goal, progress, reference variation and a safe store link', async () => {
    const fetch = mock(); mount();
    expect(screen.getByRole('status')).toHaveTextContent('Cargando');
    await screen.findByRole('heading', { name: 'Monitor' });
    expect(screen.getByText('S/ 90.00')).toBeInTheDocument();
    expect(screen.getByText('S/ 80.00 (−20 %)')).toBeInTheDocument();
    expect(screen.getByText('-10 % frente a referencia')).toBeInTheDocument();
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '50');
    expect(screen.getByRole('link', { name: 'Abrir tienda de Monitor' })).toHaveAttribute('rel', 'noopener noreferrer');
    expect(fetch).toHaveBeenCalledWith(`/api/products?list_id=${first.id}`, expect.objectContaining({ method: 'GET', credentials: 'same-origin', cache: 'no-store' }));
    await userEvent.click(screen.getByRole('button', { name: first.name }));
    expect(screen.getByRole('heading', { name: 'Monitor' })).toBeInTheDocument();
  });
  it('filters by state and reached goal, sorts by name and discount, and refreshes changed prices', async () => {
    const alpha = { ...product, id: '44444444-4444-4444-8444-444444444444', name: 'Auriculares', status: 'paused' as const, last_price: 70 };
    const fetch = mock([product, alpha]); mount();
    await screen.findByRole('heading', { name: 'Monitor' });
    const user = userEvent.setup();
    await user.selectOptions(screen.getByLabelText('Orden'), 'name');
    expect(screen.getAllByRole('article')[0]).toHaveTextContent('Auriculares');
    await user.selectOptions(screen.getByLabelText('Orden'), 'discount');
    expect(screen.getAllByRole('article')[0]).toHaveTextContent('Auriculares');
    await user.selectOptions(screen.getByLabelText('Estado'), 'paused');
    expect(screen.queryByRole('heading', { name: 'Monitor' })).not.toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText('Estado'), 'reached');
    expect(screen.getAllByRole('article')).toHaveLength(1);
    await user.selectOptions(screen.getByLabelText('Estado'), 'error');
    expect(screen.getByText('No hay productos con este estado')).toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText('Estado'), 'all');
    fetch.mockImplementation((url: string) => Promise.resolve(url === '/api/lists' ? json({ lists: [first] }) : json({ products: [{ ...product, last_price: 85 }] })));
    await user.click(screen.getByRole('button', { name: 'Actualizar productos' }));
    await screen.findByText('S/ 85.00');
  });
  it('ignores a late response from a previous list and cancels the previous request', async () => {
    let resolveOld!: (response: Response) => void;
    const fetch = mock();
    fetch.mockImplementation((url: string) => url === '/api/lists' ? Promise.resolve(json({ lists: [first, second] }))
      : url.endsWith(first.id) ? new Promise<Response>(resolve => { resolveOld = resolve; }) : Promise.resolve(json({ products: [{ ...product, list_id: second.id, name: 'Lámpara' }] })));
    mount();
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    await userEvent.click(screen.getByRole('button', { name: 'Hogar' }));
    await screen.findByRole('heading', { name: 'Lámpara' });
    resolveOld(json({ products: [product] }));
    await waitFor(() => expect(fetch.mock.calls[1][1]!.signal!.aborted).toBe(true));
    expect(screen.queryByRole('heading', { name: 'Monitor' })).not.toBeInTheDocument();
  });
  it('has distinct empty-list and no-lists states and returns from list management', async () => {
    mock([], []); mount();
    await screen.findByText('Tu primera lista empieza aquí');
    await userEvent.click(screen.getByRole('button', { name: 'Crear mi primera lista' }));
    await screen.findByRole('heading', { name: 'Tus listas' });
    await userEvent.click(screen.getByRole('button', { name: 'Volver a Inicio' }));
    await screen.findByRole('heading', { name: 'Inicio' });
  });
  it('shows product errors without raw details and can retry an empty list', async () => {
    const fetch = mock();
    fetch.mockImplementation((url: string) => Promise.resolve(url === '/api/lists' ? json({ lists: [first] }) : json({ error: 'secret' }, 503)));
    mount();
    expect(await screen.findByRole('alert')).toHaveTextContent('No pudimos cargar');
    expect(screen.queryByText('secret')).not.toBeInTheDocument();
    fetch.mockImplementation((url: string) => Promise.resolve(url === '/api/lists' ? json({ lists: [first] }) : json({ products: [] })));
    await userEvent.click(screen.getByRole('button', { name: 'Reintentar consulta' }));
    await screen.findByText('Esta lista espera tu próximo producto');
  });
  it('clears an abandoned product load when returning to an empty collection', async () => {
    let finish!: (response: Response) => void;
    let listLoads = 0;
    const fetch = vi.fn((url: string, _options?: RequestInit) => url === '/api/lists'
      ? Promise.resolve(json({ lists: listLoads++ === 0 ? [first] : [] }))
      : new Promise<Response>(resolve => { finish = resolve; }));
    vi.stubGlobal('fetch', fetch); mount();
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    await userEvent.click(screen.getByRole('button', { name: 'Gestionar listas' }));
    await screen.findByRole('heading', { name: 'Tus listas' });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Volver a Inicio' })).toBeEnabled());
    expect(fetch.mock.calls[1][1]!.signal!.aborted).toBe(true);
    await userEvent.click(screen.getByRole('button', { name: 'Volver a Inicio' }));
    await screen.findByText('Tu primera lista empieza aquí');
    finish(json({ products: [product] }));
    await waitFor(() => expect(screen.getByRole('status')).not.toHaveTextContent('Cargando'));
    expect(screen.queryByRole('heading', { name: 'Monitor' })).not.toBeInTheDocument();
  });
  it('propagates product-session expiration and survives StrictMode abandoned list loads', async () => {
    const fetch = mock();
    fetch.mockImplementation((url: string) => Promise.resolve(url === '/api/lists' ? json({ lists: [first] }) : json({}, 401)));
    const onExpired = mount(true);
    await waitFor(() => expect(onExpired).toHaveBeenCalledWith(expect.stringContaining('sesión ha caducado')));
  });
});
describe('product card and calculations', () => {
  it('keeps paused/error badges alongside reached goals and falls back after a broken image', () => {
    const { rerender } = render(<ProductCard product={{ ...product, status: 'error', last_price: 0, image_url: 'https://shop.pe/image.png' }} />);
    expect(screen.getByText('Error')).toBeInTheDocument(); expect(screen.getByText('Meta alcanzada')).toBeInTheDocument();
    fireEvent.error(screen.getByRole('img', { name: 'Monitor' }));
    expect(screen.getByText('Sin imagen')).toBeInTheDocument();
    rerender(<ProductCard product={{ ...product, status: 'paused', last_price: null, reference_price: 0 }} />);
    expect(screen.getByText('Pausado')).toBeInTheDocument();
    expect(screen.getByText('Sin precio')).toBeInTheDocument();
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
  });
  it('handles zero, increased prices, already reached references and fractional-cent percentage goals', () => {
    expect(productMetrics({ ...product, last_price: 0 })).toMatchObject({ reached: true, progress: 100, variation: -100 });
    expect(productMetrics({ ...product, last_price: 120 })).toMatchObject({ reached: false, progress: 0, variation: 20 });
    expect(productMetrics({ ...product, target_type: 'price', target_price: 120, last_price: 110 })).toMatchObject({ reached: true, progress: 100 });
    expect(productMetrics({ ...product, reference_price: 0.01, target_percent: 50, last_price: 0.01 })).toMatchObject({ reached: false, target: 0.005 });
    expect(productMetrics({ ...product, reference_price: 0 })).toMatchObject({ variation: null });
    expect(productMetrics({ ...product, reference_price: 19.99, target_percent: 10, last_price: 17.99 }).reached).toBe(true);
  });
});
describe('product transport', () => {
  it.each([{ products: [product, { ...product, last_price: -1 }] }, { products: [{ ...product, list_id: second.id }] }, { products: [{ ...product, url: 'javascript:alert(1)' }] }])('rejects invalid or mixed-list payloads', async body => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json(body)));
    await expect(requestProducts(first.id)).rejects.toThrow('respuesta de productos');
  });
});
