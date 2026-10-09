import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { AddProduct } from '../../src/components/AddProduct';
import { App } from '../../src/App';
import { requestReading } from '../../src/lib/products';

vi.mock('virtual:pwa-register/react', () => ({
  useRegisterSW: () => ({ needRefresh: [false, vi.fn()], updateServiceWorker: vi.fn() }),
}));

const id = '11111111-1111-4111-8111-111111111111';
const list = { id, name: 'Tecnología', emoji: null, position: 0, created_at: '2026-10-09' };
const result = { name: 'Monitor', price: '100.00', original_price: '120.00', currency: 'PEN', image_url: null, method: 'json_ld', confidence: 0.98, candidates: [], warnings: [] };
const row = { id, url: 'https://shop.pe/product', status: 'ready', result, product_id: null, created_at: '2026-10-09T00:00:00Z' };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

function mock(...responses: (Response | Error)[]) {
  vi.spyOn(crypto, 'randomUUID').mockReturnValue(id);
  const fetch = vi.fn();
  for (const response of responses) response instanceof Error ? fetch.mockRejectedValueOnce(response) : fetch.mockResolvedValueOnce(response);
  vi.stubGlobal('fetch', (url: string, options: RequestInit) => url === '/api/settings?view=defaults'
    ? Promise.resolve(json({ default_interval_hours: 6 })) : fetch(url, options)); return fetch;
}

function mount(lists = [list]) {
  const onSaved = vi.fn(); const onExpired = vi.fn();
  render(<AddProduct lists={lists} onClose={vi.fn()} onSaved={onSaved} onExpired={onExpired} />);
  return { onSaved, onExpired };
}

async function start() {
  fireEvent.change(screen.getByLabelText('URL del producto'), { target: { value: row.url } });
  fireEvent.click(screen.getByRole('button', { name: 'Leer producto' }));
  await screen.findByRole('heading', { name: 'Confirma lo que encontramos' });
}

function fill() {
  fireEvent.change(screen.getByLabelText('Precio objetivo'), { target: { value: '90' } });
  fireEvent.click(screen.getByLabelText('Confirmo el precio y la moneda del producto.'));
}

describe('add product', () => {
  it('reads, confirms reference, shows equivalents and saves with the default six-hour interval', async () => {
    const fetch = mock(json({ reading: row }), json({ reading: { ...row, status: 'confirmed', product_id: id } }));
    const { onSaved } = mount(); await start();
    expect(screen.getByText('100.00 PEN')).toBeInTheDocument();
    expect(screen.getByLabelText('Precio de referencia')).toHaveValue('120.00');
    expect(screen.getByLabelText('Intervalo de revisión')).toHaveValue('6');
    expect(screen.getByRole('button', { name: 'Guardar producto' })).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Condición'), { target: { value: 'percent' } });
    fireEvent.change(screen.getByLabelText('Descuento (%)'), { target: { value: '25' } });
    expect(screen.getByText('Equivalente: 90.00 PEN')).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText('Confirmo el precio y la moneda del producto.'));
    await userEvent.click(screen.getByRole('button', { name: 'Guardar producto' }));
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith(id, list.id));
    expect(JSON.parse(fetch.mock.calls[1][1].body)).toMatchObject({ action: 'confirm', reference_price: '120.00', target_type: 'percent', target_value: '25', check_interval_hours: 6, candidate_index: null });
    expect(fetch.mock.calls.every(call => call[1].credentials === 'same-origin' && call[1].cache === 'no-store')).toBe(true);
  });

  it('requires an ambiguous candidate and a currency before saving', async () => {
    mock(json({ reading: { ...row, result: { ...result, currency: null, confidence: 0.5, candidates: [{ price: '95.00', currency: null, context: 'Oferta del producto' }] } } }));
    mount(); await start();
    fill(); expect(screen.getByRole('button', { name: 'Guardar producto' })).toBeDisabled();
    fireEvent.click(screen.getByRole('radio'));
    expect(screen.getByLabelText('Confirmo el precio y la moneda del producto.')).not.toBeChecked();
    fireEvent.change(screen.getByLabelText('Moneda'), { target: { value: 'USD' } });
    fill();
    expect(screen.getByText('95.00 USD')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Guardar producto' })).toBeEnabled();
  });

  it('offers a selector after failed extraction and reads it before allowing confirmation', async () => {
    const fetch = mock(json({ reading: { ...row, status: 'failed', result: { ...result, price: null, original_price: null, confidence: 0, method: 'none' } } }), json({ reading: { ...row, result: { ...result, method: 'recipe' } } }));
    mount(); await start();
    expect(screen.queryByRole('button', { name: 'Guardar producto' })).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Enseñar un selector CSS'), { target: { value: '.final-price' } });
    await userEvent.click(screen.getByRole('button', { name: 'Leer con selector' }));
    await screen.findByText(/Selector CSS · Confianza/);
    expect(JSON.parse(fetch.mock.calls[1][1].body)).toEqual({ action: 'read', url: row.url, selector: '.final-price' });
  });

  it('blocks duplicate saves and resolves an uncertain save by querying the same ID', async () => {
    const fetch = mock(json({ reading: row }));
    let reject!: (error: Error) => void;
    fetch.mockImplementationOnce(() => new Promise((_, fail) => { reject = fail; }));
    fetch.mockResolvedValueOnce(json({ reading: { ...row, status: 'confirmed', product_id: id } }));
    const { onSaved } = mount(); await start(); fill();
    const save = screen.getByRole('button', { name: 'Guardar producto' });
    fireEvent.submit(save.closest('form')!); fireEvent.submit(save.closest('form')!);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(screen.getByRole('button', { name: 'Volver a listas' })).toBeDisabled();
    await act(async () => reject(new TypeError('network')));
    expect(await screen.findByRole('alert')).toHaveTextContent('Consulta la lectura');
    expect(save).toBeDisabled();
    await userEvent.click(screen.getByRole('button', { name: 'Consultar lectura' }));
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith(id, list.id));
    expect(fetch.mock.calls[2][0]).toBe(`/api/products/readings?id=${id}`);
    expect(fetch.mock.calls[2][1].method).toBe('GET');
  });

  it('rejects invalid reference and percentages and handles empty lists', async () => {
    const fetch = mock(json({ reading: row })); mount([]); await start();
    expect(screen.getByText('Crea una lista antes de guardar el producto.')).toBeInTheDocument();
    fill(); expect(screen.getByRole('button', { name: 'Guardar producto' })).toBeDisabled();
    fireEvent.submit(screen.getByRole('button', { name: 'Guardar producto' }).closest('form')!);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('alert')).toHaveTextContent('elige una lista');
  });

  it('polls sequentially and aborts pending polling on unmount', async () => {
    vi.useFakeTimers();
    try {
      const fetch = mock(json({ reading: { ...row, status: 'queued', result: null } }));
      let finish!: (response: Response) => void;
      fetch.mockImplementationOnce(() => new Promise<Response>(resolve => { finish = resolve; }));
      const view = render(<AddProduct lists={[list]} onClose={vi.fn()} onSaved={vi.fn()} onExpired={vi.fn()} />);
      fireEvent.change(screen.getByLabelText('URL del producto'), { target: { value: row.url } });
      await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Leer producto' })); });
      await act(async () => vi.advanceTimersByTimeAsync(1000));
      expect(fetch).toHaveBeenCalledTimes(2);
      await act(async () => vi.advanceTimersByTimeAsync(10_000));
      expect(fetch).toHaveBeenCalledTimes(2);
      view.unmount(); expect(fetch.mock.calls[1][1].signal.aborted).toBe(true);
      await act(async () => finish(json({ reading: row })));
    } finally { vi.useRealTimers(); }
  });

  it('returns to access when the session expires during the reading', async () => {
    mock(json({ authenticated: true }), json({ lists: [list] }), json({ products: [] }), json({}, 401));
    render(<App />);
    await userEvent.click(await screen.findByRole('button', { name: 'Añadir producto' }));
    fireEvent.change(screen.getByLabelText('URL del producto'), { target: { value: row.url } });
    await userEvent.click(screen.getByRole('button', { name: 'Leer producto' }));
    expect(await screen.findByLabelText('Clave de acceso')).toHaveValue('');
    expect(screen.getByRole('alert')).toHaveTextContent('Tu sesión ha caducado');
  });
});

describe('reading transport', () => {
  it('rejects malformed or mismatched successful responses and HTML fallbacks', async () => {
    for (const response of [json({ reading: { ...row, id: '22222222-2222-4222-8222-222222222222' } }), json({ reading: { ...row, result: { ...result, price: 'NaN' } } }), new Response('<html/>')]) {
      mock(response); await expect(requestReading(id)).rejects.toThrow('No pudimos confirmar');
    }
  });
  it('uses a finite timeout and maps errors without exposing arbitrary server text', async () => {
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    mock(json({ error: 'private detail' }, 503));
    await expect(requestReading(id)).rejects.toThrow('servicio');
    expect(timeout).toHaveBeenCalledWith(20_000);
  });
});
