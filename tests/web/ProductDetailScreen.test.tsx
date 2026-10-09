import { StrictMode } from 'react';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ProductDetailScreen } from '../../src/components/ProductDetailScreen';
import { HomeScreen } from '../../src/components/HomeScreen';
import { requestDetail, type ProductDetail } from '../../src/lib/products';

vi.mock('../../src/components/ProductHistory', () => ({ default: () => <div>Gráfico de precios</div> }));
const list = { id: '11111111-1111-4111-8111-111111111111', name: 'Tecnología', emoji: null, position: 0, created_at: '2026-10-09' };
const detail: ProductDetail = { product: { id: '22222222-2222-4222-8222-222222222222', list_id: list.id, name: 'Monitor', url: 'https://shop.pe/product', domain: 'shop.pe', image_url: null,
  currency: 'PEN', reference_price: 100, target_type: 'percent', target_percent: 20, target_price: 80, last_price: 90, status: 'active',
  created_at: '2026-10-08T12:00:00Z', last_checked_at: '2026-10-09T12:00:00Z', last_success_at: '2026-10-09T12:00:00Z', check_interval_hours: 3, history: [] },
  history: [{ checked_at: '2026-10-09T12:00:00Z', price: 90, currency: 'PEN' }],
  statistics: { count: 2, min: 90, max: 100, average: 95, discount_change: 10 },
  reviews: [{ id: '33333333-3333-4333-8333-333333333333', checked_at: '2026-10-09T12:00:00Z', ok: false, price: null, currency: null, method: null, error_code: 'blocked' }] };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
function mock() {
  let current = structuredClone(detail);
  const fetch = vi.fn(async (_url: string, options?: RequestInit) => {
    if (options?.method === 'PATCH') {
      const body = JSON.parse(String(options.body));
      current = { ...current, product: { ...current.product, ...body } };
      return json({ updated: true });
    }
    return options?.method === 'DELETE' ? json({ deleted: true }) : options?.method === 'POST' ? json({ queued: true }, 202) : json({ detail: current });
  });
  vi.stubGlobal('fetch', fetch); return fetch;
}
function mount(strict = false) {
  const onExpired = vi.fn(), onDeleted = vi.fn(), onBack = vi.fn();
  const element = <ProductDetailScreen id={detail.product.id} lists={[list]} onExpired={onExpired} onDeleted={onDeleted} onBack={onBack} />;
  render(strict ? <StrictMode>{element}</StrictMode> : element); return { onExpired, onDeleted, onBack };
}

describe('product detail', () => {
  it('renders historical statistics, failed reviews, safe store link and changes all ranges', async () => {
    const fetch = mock(); const { onBack } = mount(true);
    await screen.findByRole('heading', { name: 'Monitor' });
    expect(screen.getByText('S/ 95.00')).toBeInTheDocument();
    expect(screen.getByText(/\+10 puntos porcentuales/)).toBeInTheDocument();
    expect(screen.getByText('Lectura fallida · blocked')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Abrir tienda/ })).toHaveAttribute('rel', 'noopener noreferrer');
    for (const [label, range] of [['7 días', '7'], ['90 días', '90'], ['Todo', 'all'], ['30 días', '30']]) {
      await userEvent.click(screen.getByRole('button', { name: label }));
      await waitFor(() => expect(screen.getByRole('button', { name: label })).toBeEnabled());
      expect(fetch).toHaveBeenCalledWith(`/api/products/${detail.product.id}?range=${range}`, expect.objectContaining({ method: 'GET', credentials: 'same-origin', cache: 'no-store' }));
    }
    await userEvent.click(screen.getByRole('button', { name: /Volver/ })); expect(onBack).toHaveBeenCalledOnce();
  });
  it('pauses, resumes, validates edits and saves percentage goals and intervals', async () => {
    const fetch = mock(); mount(); await screen.findByRole('heading', { name: 'Monitor' });
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Pausar' }));
    await screen.findByRole('button', { name: 'Reanudar' });
    expect(screen.getByRole('button', { name: 'Revisar ahora' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Reanudar' })); await screen.findByRole('button', { name: 'Pausar' });
    await user.click(screen.getByRole('button', { name: 'Editar' }));
    await user.clear(screen.getByLabelText(/^Descuento/)); await user.type(screen.getByLabelText(/^Descuento/), '101');
    await user.click(screen.getByRole('button', { name: 'Guardar cambios' })); expect(screen.getByRole('alert')).toHaveTextContent('Revisa');
    await user.clear(screen.getByLabelText(/^Descuento/)); await user.type(screen.getByLabelText(/^Descuento/), '25');
    expect(screen.getByText('Equivale a S/ 75.00')).toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText('Intervalo'), '12');
    await user.click(screen.getByRole('button', { name: 'Guardar cambios' }));
    await waitFor(() => expect(screen.queryByRole('form')).not.toBeInTheDocument());
    const calls = fetch.mock.calls.filter(([, options]) => options?.method === 'PATCH');
    expect(calls).toHaveLength(3);
    expect(JSON.parse(String(calls[2][1]?.body))).toEqual({ name: 'Monitor', list_id: list.id, reference_price: '100', target_type: 'percent', target_value: '25', check_interval_hours: 12 });
  });
  it('requires explicit deletion confirmation and supports cancellation', async () => {
    const fetch = mock(); const { onDeleted } = mount(); await screen.findByRole('heading', { name: 'Monitor' });
    await userEvent.click(screen.getByRole('button', { name: 'Eliminar' }));
    expect(fetch.mock.calls.some(([, o]) => o?.method === 'DELETE')).toBe(false);
    await userEvent.click(screen.getByRole('button', { name: 'Cancelar' }));
    expect(screen.queryByRole('group', { name: 'Confirmar eliminación' })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Eliminar' }));
    await userEvent.click(screen.getByRole('button', { name: 'Eliminar definitivamente' }));
    await waitFor(() => expect(onDeleted).toHaveBeenCalledOnce());
    expect(fetch.mock.calls.filter(([, o]) => o?.method === 'DELETE')).toHaveLength(1);
  });
  it('prevents duplicate review clicks and refreshes the result', async () => {
    const fetch = mock(); mount(); await screen.findByRole('heading', { name: 'Monitor' });
    await userEvent.dblClick(screen.getByRole('button', { name: 'Revisar ahora' }));
    expect(fetch.mock.calls.filter(([, o]) => o?.method === 'POST')).toHaveLength(1);
    expect(screen.getByRole('status')).toHaveTextContent('Revisión solicitada');
    expect(screen.getByRole('button', { name: 'Revisar ahora' })).toBeDisabled();
    fetch.mockImplementation(async (_url, options) => json({ detail: { ...detail, product: { ...detail.product, last_checked_at: '2026-10-09T13:00:00Z', last_price: 85 } } }));
    await userEvent.click(screen.getByRole('button', { name: 'Actualizar detalle' }));
    await screen.findByText('S/ 85.00'); expect(screen.getByRole('button', { name: 'Revisar ahora' })).toBeEnabled();
  });
  it('shows empty history and handles expired sessions', async () => {
    const fetch = mock(); const { onExpired } = mount(); await screen.findByRole('heading', { name: 'Monitor' });
    let resolveOld!: (r: Response) => void;
    fetch.mockImplementation((url, _options) => url.endsWith('range=7') ? new Promise<Response>(resolve => { resolveOld = resolve; }) : Promise.resolve(json({ detail: { ...detail, history: [] } })));
    await userEvent.click(screen.getByRole('button', { name: '7 días' }));
    const signal = fetch.mock.calls.at(-1)![1]!.signal!;
    await userEvent.click(screen.getByRole('button', { name: /Volver/ }));
    resolveOld(json({ detail: { ...detail, history: [] } }));
    await screen.findByText(/No hay precios válidos/);
    fetch.mockImplementation(async () => json({ error: 'expired' }, 401));
    await userEvent.click(screen.getByRole('button', { name: 'Actualizar detalle' }));
    await waitFor(() => expect(onExpired).toHaveBeenCalledOnce());
    expect(signal).toBeDefined();
  });
  it('aborts an unmounted detail query and ignores its late response', async () => {
    let resolveLate!: (response: Response) => void;
    const fetch = vi.fn((_url: string, _options?: RequestInit) => new Promise<Response>(resolve => { resolveLate = resolve; }));
    vi.stubGlobal('fetch', fetch);
    const onExpired = vi.fn();
    const view = render(<ProductDetailScreen id={detail.product.id} lists={[list]} onExpired={onExpired} onDeleted={vi.fn()} onBack={vi.fn()} />);
    const signal = fetch.mock.calls[0][1]!.signal!;
    view.unmount();
    expect(signal.aborted).toBe(true);
    resolveLate(json({ error: 'expired' }, 401));
    await Promise.resolve(); await Promise.resolve();
    expect(onExpired).not.toHaveBeenCalled();
  });
  it('rejects malformed detail responses and allows retry after a connection error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(json({ detail })));
    mount(); await screen.findByRole('alert');
    await userEvent.click(screen.getByRole('button', { name: 'Actualizar detalle' })); await screen.findByRole('heading', { name: 'Monitor' });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({ detail: { ...detail, product: { ...detail.product, id: list.id } } })));
    await expect(requestDetail(detail.product.id)).rejects.toThrow('no es válida');
  });
  it('opens detail from home and returns to reload the selected list', async () => {
    const fetch = vi.fn(async (url: string) => url === '/api/lists' ? json({ lists: [list] }) : url.includes('?list_id=') ? json({ products: [detail.product] }) : json({ detail }));
    vi.stubGlobal('fetch', fetch);
    render(<HomeScreen onExpired={vi.fn()} onLogout={vi.fn()} sessionBusy={false} sessionError="" />);
    await userEvent.click(await screen.findByRole('button', { name: 'Ver detalle de Monitor' }));
    await screen.findByRole('heading', { name: 'Estadísticas históricas' });
    await userEvent.click(screen.getByRole('button', { name: /Volver/ }));
    await screen.findByRole('heading', { name: 'Inicio' });
    expect(await within(screen.getByRole('article')).findByRole('button', { name: 'Ver detalle de Monitor' })).toBeInTheDocument();
    expect(fetch.mock.calls.filter(([url]) => url.includes('?list_id='))).toHaveLength(2);
  });
});
