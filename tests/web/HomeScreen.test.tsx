import { StrictMode } from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HomeScreen } from '../../src/components/HomeScreen';
import { ProductCard } from '../../src/components/ProductCard';
import { PwaInstallProvider } from '../../src/components/PwaInstallProvider';
import { productMetrics, requestProducts, type ProductSummary } from '../../src/lib/products';
import { purchaseFixture, purchaseId } from '../fixtures/purchase-ui';

const first = { id: '11111111-1111-4111-8111-111111111111', name: 'Tecnología', emoji: null, position: 0, created_at: '2026-10-09' };
const second = { ...first, id: '22222222-2222-4222-8222-222222222222', name: 'Hogar', position: 1 };
const product: ProductSummary = { id: '33333333-3333-4333-8333-333333333333', list_id: first.id,
  url: 'https://shop.pe/product', domain: 'shop.pe', name: 'Monitor', image_url: null, currency: 'PEN',
  reference_price: 100, target_type: 'percent', target_price: 80, target_percent: 20, last_price: 90,
  status: 'active', created_at: '2026-10-09T00:00:00Z', last_checked_at: '2026-10-09T12:00:00Z', last_success_at: '2026-10-09T12:00:00Z', history: [],
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
function mount(strict = false, sessionError = '') {
  const onExpired = vi.fn();
  const element = <HomeScreen onExpired={onExpired} onLogout={vi.fn()} sessionBusy={false} sessionError={sessionError} />;
  render(strict ? <StrictMode><PwaInstallProvider>{element}</PwaInstallProvider></StrictMode> : <PwaInstallProvider>{element}</PwaInstallProvider>);
  return onExpired;
}
function mock(products: ProductSummary[] = [product], lists = [first, second]) {
  const fetch = vi.fn((url: string, _options?: RequestInit) => Promise.resolve(url === '/api/product-groups' ? json({ groups: [] }) : url === '/api/lists' ? json({ lists }) : json({ products })));
  vi.stubGlobal('fetch', fetch);
  return fetch;
}
afterEach(() => window.history.replaceState(null, '', '/'));
describe('independent catalog', () => {
  it('opens a notice basket directly and removes its destination when leaving the breakdown', async () => {
    const previous = window.location.href;
    try {
      window.history.replaceState(null, '', `/?basket=${purchaseId.toUpperCase()}&source=notice#details`);
      const fetch = vi.fn(async (url: string) => url.includes('/purchases') ? json(purchaseFixture())
        : url === '/api/product-groups' ? json({ groups: [] }) : url === '/api/lists' ? json({ lists: [] }) : json({ products: [] }));
      vi.stubGlobal('fetch', fetch);
      mount(true);
      await screen.findByRole('heading', { name: 'Tu canasta' });
      await screen.findByText(/Ahorro frente a referencia: S\/ 0.01/);
      expect(fetch.mock.calls.some(([url]) => url === `/api/baskets/${purchaseId}/purchases?page=0`)).toBe(true);
      expect(document.title).toBe('Scrappy · Detalle de canasta');
      await userEvent.click(screen.getByRole('button', { name: '← Volver a Canastas' }));
      await screen.findByRole('heading', { name: 'Tus canastas' });
      expect(window.location.search).toBe('?source=notice&view=lists');
      expect(window.location.hash).toBe('#details');
    } finally { window.history.replaceState(null, '', previous); }
  });
  it.each(['invalid', `${purchaseId}&basket=${purchaseId}`])('ignores malformed or ambiguous notice destinations: %s', async query => {
    const previous = window.location.href;
    try {
      window.history.replaceState(null, '', `/?basket=${query}`);
      const fetch = mock([], []);
      mount(); await screen.findByText('Tu catálogo espera tu próximo producto');
      expect(fetch.mock.calls.every(([url]) => !url.startsWith('/api/baskets/'))).toBe(true);
    } finally { window.history.replaceState(null, '', previous); }
  });
  it('reads products without baskets, keeps filters and sorts', async () => {
    const fetch = mock([product, { ...product, id: second.id, name: 'Auriculares', status: 'paused', last_price: 70 }], []);
    mount(); await screen.findByRole('heading', { name: 'Monitor' });
    expect(fetch).toHaveBeenCalledWith('/api/products', expect.objectContaining({ credentials: 'same-origin', cache: 'no-store' }));
    expect(screen.queryByRole('navigation', { name: 'Listas de productos' })).not.toBeInTheDocument();
    await userEvent.selectOptions(screen.getByLabelText('Orden'), 'name');
    expect(screen.getAllByRole('article')[0]).toHaveTextContent('Auriculares');
    await userEvent.selectOptions(screen.getByLabelText('Estado'), 'paused');
    expect(screen.queryByRole('heading', { name: 'Monitor' })).not.toBeInTheDocument();
  });
  it('has an empty catalog and allows adding without a basket', async () => {
    mock([], []); mount(); await screen.findByText('Tu catálogo espera tu próximo producto');
    await userEvent.click(screen.getAllByRole('button', { name: 'Añadir producto' })[0]);
    expect(await screen.findByRole('heading', { name: 'Añadir producto' })).toBeInTheDocument();
  });
  it.each(['pending', 'failed'])('shows the catalog when basket loading is %s', async state => {
    vi.stubGlobal('fetch', vi.fn((url: string) => url === '/api/product-groups' ? Promise.resolve(json({ groups: [] })) : url === '/api/lists'
      ? state === 'pending' ? new Promise<Response>(() => {}) : Promise.resolve(json({}, 503))
      : Promise.resolve(json({ products: [product] }))));
    mount();
    expect(await screen.findByRole('heading', { name: 'Monitor' })).toBeInTheDocument();
    expect(screen.getByRole('status')).not.toHaveTextContent('Cargando');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
  it('keeps basket summaries in the independent basket view', async () => {
    const detail = (await import('../fixtures/basket-experience')).basketDetail;
    const fetch = mock([], [first]);
    fetch.mockImplementation((url: string) => Promise.resolve(url.includes('/purchases') ? json({ schema_version: 2, list_id: first.id, mode: 'legacy', version: '1', configuration: null, latest_evaluation: null, stale_reason: 'mode', events: [], has_more: false }) : url.startsWith('/api/baskets/') ? json({ detail })
      : url === '/api/product-groups' ? json({ groups: [] }) : url === '/api/lists' ? json({ lists: [first] }) : json({ products: [] })));
    mount(); await screen.findByText('Tu catálogo espera tu próximo producto');
    await userEvent.click(screen.getByRole('button', { name: 'Gestionar canastas' }));
    expect(await screen.findByRole('heading', { name: 'Tus canastas' })).toBeInTheDocument();
    await screen.findByRole('heading', { name: first.name });
    expect(screen.getByRole('button', { name: 'Ver canasta' })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Ver canasta' }));
    await screen.findByRole('heading', { name: first.name });
    expect(document.title).toBe('Scrappy · Detalle de canasta');
  });
  it('shows a logout failure as an alert without hiding loaded products or blocking grouping', async () => {
    const fetch = mock([product, { ...product, id: second.id, domain: 'otra.pe' }], []);
    mount(false, 'No se pudo cerrar la sesión.');
    expect(await screen.findAllByRole('article')).toHaveLength(2);
    expect(screen.getByRole('alert')).toHaveTextContent('No se pudo cerrar la sesión.');
    expect(screen.queryByRole('button', { name: 'Reintentar consulta' })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Seleccionar Monitor · shop.pe' }));
    await userEvent.click(screen.getByRole('button', { name: 'Seleccionar Monitor · otra.pe' }));
    expect(screen.getByRole('button', { name: /Continuar/ })).toBeEnabled();
    expect(fetch.mock.calls.filter(([url]) => url === '/api/products')).toHaveLength(1);
  });
  it('offers a retry only when loading products actually fails', async () => {
    let failed = true;
    vi.stubGlobal('fetch', vi.fn((url: string) => Promise.resolve(url === '/api/product-groups' ? json({ groups: [] }) : url === '/api/lists' ? json({ lists: [] })
      : failed ? json({}, 503) : json({ products: [product] }))));
    mount(false, 'No se pudo cerrar la sesión.');
    await screen.findByRole('button', { name: 'Reintentar consulta' });
    expect(screen.getAllByRole('alert')).toHaveLength(2);
    expect(screen.getAllByRole('alert').map(alert => alert.textContent)).toContain('No se pudo cerrar la sesión.');
    failed = false;
    await userEvent.click(screen.getByRole('button', { name: 'Reintentar consulta' }));
    expect(await screen.findAllByRole('article')).toHaveLength(1);
    expect(screen.queryByRole('button', { name: 'Reintentar consulta' })).not.toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('No se pudo cerrar la sesión.');
  });
  it('expires product sessions and survives StrictMode', async () => {
    const fetch=mock(); fetch.mockImplementation((url: string) => Promise.resolve(url === '/api/product-groups' ? json({ groups: [] }) : url === '/api/lists' ? json({ lists: [] }) : json({},401)));
    const expired=mount(true); await waitFor(() => expect(expired).toHaveBeenCalledWith(expect.stringContaining('sesión')));
  });
});
describe('history navigation', () => {
  const back = async () => { window.history.back(); await new Promise(resolve => setTimeout(resolve, 20)); };
  it('pushes each view to the URL and follows the browser back and forward buttons', async () => {
    window.history.replaceState(null, '', '/?source=pwa');
    mock(); mount(); await screen.findByRole('heading', { name: 'Monitor' });
    const start = window.history.length;
    await userEvent.click(screen.getAllByRole('button', { name: 'Ajustes' })[0]);
    expect(await screen.findByRole('heading', { name: 'Ajustes', level: 1 })).toBeInTheDocument();
    expect(window.location.search).toBe('?source=pwa&view=settings');
    await userEvent.click(screen.getByRole('button', { name: 'Gestionar canastas' }));
    expect(await screen.findByRole('heading', { name: 'Tus canastas' })).toBeInTheDocument();
    expect(window.location.search).toBe('?source=pwa&view=lists');
    expect(window.history.length).toBe(start + 2);
    await back();
    expect(await screen.findByRole('heading', { name: 'Ajustes', level: 1 })).toBeInTheDocument();
    expect(document.title).toBe('Scrappy · Ajustes');
    await back();
    expect(await screen.findByRole('heading', { name: 'Monitor' })).toBeInTheDocument();
    expect(window.location.search).toBe('?source=pwa');
    window.history.forward(); await new Promise(resolve => setTimeout(resolve, 20));
    expect(await screen.findByRole('heading', { name: 'Ajustes', level: 1 })).toBeInTheDocument();
  });
  it('pushes a product detail and returns to the catalog with the back button', async () => {
    const fetch = mock(); mount(); await screen.findByRole('heading', { name: 'Monitor' });
    await userEvent.click(screen.getByRole('button', { name: 'Ver detalle de Monitor' }));
    expect(window.location.search).toBe(`?product=${product.id}`);
    expect(document.title).toBe('Scrappy · Detalle de producto');
    await waitFor(() => expect(fetch.mock.calls.some(([url]) => url.startsWith(`/api/products/${product.id}`))).toBe(true));
    await back();
    expect(await screen.findByRole('heading', { name: 'Productos' })).toBeInTheDocument();
    expect(document.title).toBe('Scrappy · Productos');
    expect(window.location.search).toBe('');
  });
  it.each([
    ['product', 'Scrappy · Detalle de producto', `/api/products/${product.id}?range=30`],
    ['group', 'Scrappy · Detalle de grupo', `/api/product-groups?id=${product.id}`],
  ])('restores ?%s=<id> when the app is opened or reloaded', async (key, title, endpoint) => {
    window.history.replaceState(null, '', `/?${key}=${product.id.toUpperCase()}`);
    const fetch = mock(); mount();
    await waitFor(() => expect(fetch.mock.calls.some(([url]) => url === endpoint)).toBe(true));
    expect(document.title).toBe(title);
    expect(fetch.mock.calls.some(([url]) => url === '/api/products')).toBe(false);
  });
  it.each([['settings', 'Ajustes'], ['lists', 'Tus canastas'], ['add', 'Añadir producto']])('restores ?view=%s on reload', async (view, heading) => {
    window.history.replaceState(null, '', `/?view=${view}`);
    mock(); mount();
    expect(await screen.findByRole('heading', { name: heading, level: 1 })).toBeInTheDocument();
  });
  it('asks before the back button discards unsaved basket edits', async () => {
    window.history.pushState(null, '', `/?basket=${purchaseId}`);
    const detail = (await import('../fixtures/basket-experience')).basketDetail;
    vi.stubGlobal('fetch', vi.fn(async (url: string) => url === '/api/product-groups' ? json({ groups: [] }) : url === '/api/products' ? json({ products: [product] })
      : url === '/api/lists' ? json({ lists: [{ ...first, id: purchaseId }] }) : url.includes('/purchases') ? json(purchaseFixture()) : json({ detail: { ...detail, id: purchaseId } })));
    mount();
    await userEvent.click(await screen.findByRole('button', { name: 'Editar mi compra' }));
    fireEvent.change(screen.getByLabelText('Nombre de necesidad 1'), { target: { value: 'Borrador' } });
    await back();
    expect(await screen.findByRole('alertdialog')).toBeInTheDocument();
    expect(window.location.search).toBe(`?basket=${purchaseId}`);
    await userEvent.click(screen.getByRole('button', { name: 'Seguir editando' }));
    expect(screen.getByLabelText('Nombre de necesidad 1')).toHaveValue('Borrador');
    await back();
    await userEvent.click(await screen.findByRole('button', { name: 'Salir sin guardar' }));
    expect(await screen.findByRole('heading', { name: 'Productos' })).toBeInTheDocument();
    expect(window.location.search).toBe('');
  });
  it('ignores ambiguous or unknown destinations and opens the catalog', async () => {
    window.history.replaceState(null, '', `/?product=${product.id}&product=${second.id}&view=unknown`);
    mock(); mount();
    expect(await screen.findByRole('heading', { name: 'Monitor' })).toBeInTheDocument();
    expect(document.title).toBe('Scrappy · Productos');
  });
});
describe('product card and calculations', () => {
  it.each([
    ['2026-10-09T08:00:00Z', 'Precio desactualizado', /La última revisión no obtuvo un precio válido; se muestra la lectura anterior/],
    [null, 'Revisión pendiente', /La última revisión no obtuvo un precio válido; se reintentará en la próxima revisión/],
  ])('warns when an active reading is stale (last success %s)', (lastSuccess, badge, explanation) => {
    render(<ProductCard product={{ ...product, last_success_at: lastSuccess, last_checked_at: '2026-10-09T12:00:00Z' }} />);
    expect(screen.getByText(badge)).toBeInTheDocument();
    expect(screen.getByText('Activo')).toBeInTheDocument();
    expect(screen.getByText(explanation)).toBeInTheDocument();
  });
  it('omits the stale warning for fresh, paused or error readings', () => {
    const { rerender } = render(<ProductCard product={product} />);
    expect(screen.queryByText(/desactualizado|Revisión pendiente/)).not.toBeInTheDocument();
    rerender(<ProductCard product={{ ...product, status: 'paused', last_success_at: '2026-10-09T08:00:00Z' }} />);
    expect(screen.queryByText(/desactualizado|Revisión pendiente/)).not.toBeInTheDocument();
    rerender(<ProductCard product={{ ...product, status: 'error', last_success_at: '2026-10-09T08:00:00Z' }} />);
    expect(screen.queryByText(/desactualizado|Revisión pendiente/)).not.toBeInTheDocument();
  });
  it('filters the catalog down to stale readings', async () => {
    mock([product, { ...product, id: second.id, name: 'Auriculares', last_success_at: '2026-10-09T08:00:00Z' }], []);
    mount(); await screen.findByRole('heading', { name: 'Monitor' });
    await userEvent.selectOptions(screen.getByLabelText('Estado'), 'stale');
    expect(screen.queryByRole('heading', { name: 'Monitor' })).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Auriculares' })).toBeInTheDocument();
    expect(within(screen.getByRole('article')).getByText('Precio desactualizado')).toBeInTheDocument();
  });

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
  it.each([{ products: [product, { ...product, last_price: -1 }] }, { products: [{ ...product, url: 'javascript:alert(1)' }] }])('rejects invalid or mixed-list payloads', async body => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json(body)));
    await expect(requestProducts(first.id)).rejects.toThrow('respuesta de productos');
  });
});
