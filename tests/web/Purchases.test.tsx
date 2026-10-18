import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { StrictMode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { PurchaseBasketScreen } from '../../src/components/PurchaseBasketScreen';
import { PurchaseResults } from '../../src/components/PurchaseResults';
import { PurchaseSummary } from '../../src/components/PurchaseSummary';
import { publication, readPurchases } from '../../src/lib/purchases';
import type { ProductSummary } from '../../src/lib/products';
import { purchaseFixture, purchaseId, uid } from '../fixtures/purchase-ui';

const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status });
const catalogProduct: ProductSummary = { id: uid(4), list_id: null, url: 'https://shop.example/combo', domain: 'shop.example', name: 'Combo recuperado',
  image_url: null, currency: 'PEN', reference_price: null, target_type: null, target_price: null, target_percent: null, last_price: 5,
  status: 'active', created_at: '2026-10-16T18:00:00Z', last_checked_at: '2026-10-16T18:00:00Z', last_success_at: '2026-10-16T18:00:00Z', history: [] };
function mount(mode: 'ok' | 'conflict' | 'lost' = 'ok') {
  let data = purchaseFixture();
  const fetch = vi.fn(async (url: string, options?: RequestInit): Promise<Response> => {
    if (url === '/api/products') return json({ products: [] });
    if (options?.method === 'PUT') {
      if (mode === 'conflict') return json({}, 409);
      const version = (BigInt(data.version) + 1n).toString();
      data = { ...data, version, configuration: { ...JSON.parse(String(options.body)).configuration, version }, latest_evaluation: null, stale_reason: 'dirty' };
      if (mode === 'lost') throw new Error('Lost response after commit');
      return json({ schema_version: 2, configuration: data.configuration });
    }
    return json(data);
  });
  vi.stubGlobal('fetch', fetch);
  const onExpired = vi.fn();
  render(<PurchaseBasketScreen id={purchaseId} onBack={vi.fn()} onExpired={onExpired} />);
  return { fetch, onExpired };
}
function action(name: string) {
  if (name === 'Guardar cambios') {
    const toggle = screen.queryByRole('button', { name: 'Editar mi compra' });
    if (toggle && !(toggle as HTMLButtonElement).disabled) fireEvent.click(toggle);
  }
  if (name === 'Cargar más recibos') {
    const activity = screen.queryByText('Actividad y avisos');
    const details = activity?.closest('details');
    if (details && !details.open) fireEvent.click(activity!);
  }
  return screen.getByRole('button', { name, hidden: true });
}
function deferredReads() {
  const reads: { url: string; signal: AbortSignal; resolve: (v: Response) => void; reject: (e: Error) => void }[] = [];
  const fetch = vi.fn((url: string, options?: RequestInit) => url === '/api/products'
    ? Promise.resolve(json({ products: [] }))
    : new Promise<Response>((resolve, reject) => { reads.push({ url, signal: options!.signal!, resolve, reject }); }));
  vi.stubGlobal('fetch', fetch);
  return { reads, fetch };
}
describe('purchase UI', () => {
  it('retries failed catalogs and refreshes products added elsewhere on consultation without losing the draft', async () => {
    let failed = true;
    let products = [catalogProduct];
    const fetch = vi.fn(async (url: string) => url === '/api/products' ? json({ products }, failed ? 503 : 200) : json(purchaseFixture()));
    vi.stubGlobal('fetch', fetch);
    render(<PurchaseBasketScreen id={purchaseId} onBack={vi.fn()} onExpired={vi.fn()} />);
    await screen.findByRole('alert');
    fireEvent.change(screen.getByLabelText('Nombre de necesidad 1'), { target: { value: 'Borrador propio' } });
    await userEvent.click(screen.getByRole('button', { name: 'Actualizar resultado' }));
    await screen.findByRole('alert');
    expect(screen.queryByLabelText('Resultado de alternativas')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Nombre de necesidad 1')).toHaveValue('Borrador propio');
    failed = false;
    await userEvent.click(screen.getByRole('button', { name: 'Actualizar resultado' }));
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
    expect(within(screen.getByLabelText('Producto de oferta 1')).getByRole('option', { hidden: true, name: 'Combo recuperado · shop.example' })).toBeInTheDocument();
    expect(screen.getByLabelText('Resultado de alternativas')).toBeInTheDocument();
    products = [...products, { ...catalogProduct, id: uid(50), name: 'Producto de otra pestaña' }];
    await userEvent.click(screen.getByRole('button', { name: 'Actualizar resultado' }));
    await waitFor(() => expect(within(screen.getByLabelText('Producto de oferta 1')).getByRole('option', { hidden: true, name: 'Producto de otra pestaña · shop.example' })).toBeInTheDocument());
    expect(screen.getByLabelText('Nombre de necesidad 1')).toHaveValue('Borrador propio');
    expect(fetch.mock.calls.filter(([url]) => url === '/api/products')).toHaveLength(4);
  });
  it.each([200, 401])('ignores a late catalog response (%s) after changing baskets', async status => {
    let resolve!: (v: Response) => void;
    let catalogs = 0;
    vi.stubGlobal('fetch', vi.fn((url: string) => {
      if (url === '/api/products') return ++catalogs === 1 ? new Promise<Response>(yes => { resolve = yes; }) : Promise.resolve(json({ products: [] }));
      return Promise.resolve(json({ ...purchaseFixture(), list_id: url.includes(uid(40)) ? uid(40) : purchaseId }));
    }));
    const props = { onBack: vi.fn(), onExpired: vi.fn() };
    const { rerender } = render(<PurchaseBasketScreen id={purchaseId} {...props} />);
    await screen.findByLabelText('Nombre de necesidad 1');
    expect(screen.getByRole('button', { name: 'Actualizar resultado' })).toBeDisabled();
    rerender(<PurchaseBasketScreen id={uid(40)} {...props} />);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Actualizar resultado' })).toBeEnabled());
    fireEvent.change(screen.getByLabelText('Nombre de necesidad 1'), { target: { value: 'Destino nuevo' } });
    await act(async () => { resolve(json({ products: [catalogProduct] }, status)); });
    expect(screen.getByLabelText('Nombre de necesidad 1')).toHaveValue('Destino nuevo');
    expect(within(screen.getByLabelText('Producto de oferta 1')).queryByRole('option', { hidden: true, name: 'Combo recuperado · shop.example' })).not.toBeInTheDocument();
    expect(props.onExpired).not.toHaveBeenCalled();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
  it.each(['resolve', 'reject'] as const)('serializes StrictMode initial loading and ignores an obsolete %s including its finalizer', async outcome => {
    const { reads, fetch } = deferredReads();
    const onExpired = vi.fn();
    render(<StrictMode><PurchaseBasketScreen id={purchaseId} onBack={vi.fn()} onExpired={onExpired} /></StrictMode>);
    expect(reads).toHaveLength(2);
    expect(reads[0].signal.aborted).toBe(true);
    expect(screen.getByRole('button', { name: 'Actualizar resultado' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Actualizar resultado' }));
    expect(reads).toHaveLength(2);
    await act(async () => { reads[1].resolve(json(purchaseFixture())); });
    fireEvent.change(screen.getByLabelText('Nombre de necesidad 1'), { target: { value: 'Borrador propio' } });
    fireEvent.click(screen.getByRole('button', { name: 'Actualizar resultado' }));
    expect(reads).toHaveLength(3);
    await act(async () => {
      if (outcome === 'resolve') reads[0].resolve(json(purchaseFixture()));
      else reads[0].reject(new Error('late failure'));
    });
    expect(screen.getByRole('button', { name: 'Actualizar resultado' })).toBeDisabled();
    expect(screen.getByLabelText('Nombre de necesidad 1')).toHaveValue('Borrador propio');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    await act(async () => { reads[2].resolve(json(purchaseFixture())); });
    expect(screen.getByRole('button', { name: 'Actualizar resultado' })).toBeEnabled();
    expect(screen.getByLabelText('Nombre de necesidad 1')).toHaveValue('Borrador propio');
    fireEvent.click(action('Guardar cambios'));
    expect(JSON.parse(String(fetch.mock.calls.at(-1)![1]!.body)).expected_version).toBe(purchaseFixture().version);
    expect(onExpired).not.toHaveBeenCalled();
  });
  it('allows retry after initial failure without a draft or concurrent reads', async () => {
    const { reads } = deferredReads();
    render(<PurchaseBasketScreen id={purchaseId} onBack={vi.fn()} onExpired={vi.fn()} />);
    await act(async () => { reads[0].reject(new Error('offline')); });
    expect(screen.getByRole('alert')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Actualizar resultado' }));
    fireEvent.click(screen.getByRole('button', { name: 'Actualizar resultado' }));
    expect(reads).toHaveLength(2);
    await act(async () => { reads[1].resolve(json(purchaseFixture())); });
    expect(screen.getByLabelText('Nombre de necesidad 1')).toHaveValue('Agua');
    expect(action('Guardar cambios')).toBeEnabled();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
  it.each(['Actualizar resultado', 'Cargar más recibos'])('invalidates results during and after a failed %s while preserving the draft and recovering', async name => {
    const { reads } = deferredReads();
    const d = purchaseFixture(); d.has_more = true;
    render(<PurchaseBasketScreen id={purchaseId} onBack={vi.fn()} onExpired={vi.fn()} />);
    await act(async () => { reads[0].resolve(json(d)); });
    fireEvent.change(screen.getByLabelText('Nombre de necesidad 1'), { target: { value: 'Borrador propio' } });
    fireEvent.click(action(name));
    expect(screen.queryByLabelText('Resultado de alternativas')).not.toBeInTheDocument();
    expect(screen.getByText(/Sin resultado vigente/)).toBeInTheDocument();
    await act(async () => { reads[1].reject(new Error('offline')); });
    expect(screen.getByRole('alert')).toBeInTheDocument();
    expect(screen.queryByText(/Ahorro frente a referencia/)).not.toBeInTheDocument();
    expect(screen.getByLabelText('Nombre de necesidad 1')).toHaveValue('Borrador propio');
    fireEvent.click(action(name));
    expect(reads[2].url).toContain(name === 'Cargar más recibos' ? 'page=1' : 'page=0');
    await act(async () => { reads[2].resolve(json(name === 'Cargar más recibos' ? { ...d, events: [{ ...d.events[0], id: uid(30) }], has_more: false } : d)); });
    expect(screen.getByLabelText('Resultado de alternativas')).toBeInTheDocument();
    expect(screen.getByLabelText('Nombre de necesidad 1')).toHaveValue('Borrador propio');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getAllByText('Correo: Entrega incierta')).toHaveLength(name === 'Cargar más recibos' ? 2 : 1);
  });
  it('keeps a cross-version receipt response invalid until explicit consultation and draft reconciliation', async () => {
    const { reads } = deferredReads();
    const d = purchaseFixture(); d.has_more = true;
    render(<PurchaseBasketScreen id={purchaseId} onBack={vi.fn()} onExpired={vi.fn()} />);
    await act(async () => { reads[0].resolve(json(d)); });
    fireEvent.change(screen.getByLabelText('Nombre de necesidad 1'), { target: { value: 'Borrador propio' } });
    const next = { ...d, version: (BigInt(d.version) + 1n).toString(), latest_evaluation: null, stale_reason: 'dirty' };
    fireEvent.click(action('Cargar más recibos'));
    await act(async () => { reads[1].resolve(json(next)); });
    expect(screen.queryByLabelText('Resultado de alternativas')).not.toBeInTheDocument();
    expect(action('Guardar cambios')).toBeDisabled();
    expect(action('Descartar borrador y cargar versión guardada')).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Actualizar resultado' }));
    await act(async () => { reads[2].resolve(json(next)); });
    expect(screen.getByLabelText('Nombre de necesidad 1')).toHaveValue('Borrador propio');
    expect(action('Guardar cambios')).toBeDisabled();
    fireEvent.click(action('Descartar borrador y cargar versión guardada'));
    expect(screen.getByLabelText('Nombre de necesidad 1')).toHaveValue('Agua');
    expect(action('Guardar cambios')).toBeEnabled();
  });
  it.each(['initial', 'consult', 'save'] as const)('ignores an old basket %s response after changing the destination', async stage => {
    const { reads } = deferredReads();
    const props = { onBack: vi.fn(), onExpired: vi.fn() };
    const { rerender } = render(<PurchaseBasketScreen id={purchaseId} {...props} />);
    if (stage !== 'initial') {
      await act(async () => { reads[0].resolve(json(purchaseFixture())); });
      fireEvent.click(action(stage === 'save' ? 'Guardar cambios' : 'Actualizar resultado'));
    }
    const old = reads.at(-1)!;
    const id = uid(40);
    rerender(<PurchaseBasketScreen id={id} {...props} />);
    const current = reads.at(-1)!;
    expect(screen.queryByLabelText('Nombre de necesidad 1')).not.toBeInTheDocument();
    await act(async () => { old.resolve(stage === 'save' ? json({ schema_version: 2, configuration: { version: (BigInt(purchaseFixture().version) + 1n).toString() } }) : json({}, 401)); });
    expect(screen.getByRole('button', { name: 'Actualizar resultado' })).toBeDisabled();
    expect(reads.at(-1)).toBe(current);
    const d = purchaseFixture(); d.list_id = id; d.configuration!.needs[0].name = 'Destino nuevo';
    await act(async () => { current.resolve(json(d)); });
    expect(screen.getByLabelText('Nombre de necesidad 1')).toHaveValue('Destino nuevo');
    expect(screen.getByRole('button', { name: 'Actualizar resultado' })).toBeEnabled();
    expect(props.onExpired).not.toHaveBeenCalled();
  });
  it('invalidates a cached summary while refreshing, reports failure and clears error on recovery', async () => {
    const basket = { budget: 6, currency: 'PEN', total: null, complete: false, product_count: 2, valid_count: 0 };
    const fetch = vi.fn(async () => json(purchaseFixture()));
    vi.stubGlobal('fetch', fetch);
    const props = { id: purchaseId, basket, onExpired: vi.fn() };
    const { rerender } = render(<PurchaseSummary {...props} />);
    await screen.findByText(/Ahorro frente a referencia: S\/ 0.01/);
    let reject!: (e: Error) => void;
    fetch.mockImplementationOnce(() => new Promise<Response>((_, no) => { reject = no; }));
    rerender(<PurchaseSummary {...props} basket={{ ...basket }} />);
    expect(screen.queryByLabelText('Resultado de alternativas')).not.toBeInTheDocument();
    expect(screen.getByText('Consultando compra vigente…')).toBeInTheDocument();
    reject(new Error('offline'));
    await screen.findByText(/No pudimos consultar alternativas/);
    expect(screen.queryByText(/S\/ 0.01/)).not.toBeInTheDocument();
    rerender(<PurchaseSummary {...props} basket={{ ...basket }} />);
    await screen.findByText(/Ahorro frente a referencia: S\/ 0.01/);
    expect(screen.queryByText(/No pudimos consultar alternativas/)).not.toBeInTheDocument();
  });
  it('does not restore an aborted summary response after a newer refresh expires the session', async () => {
    const basket = { budget: 6, currency: 'PEN', total: null, complete: false, product_count: 2, valid_count: 0 };
    let resolve!: (v: Response) => void;
    const fetch = vi.fn(() => new Promise<Response>(yes => { resolve = yes; }));
    vi.stubGlobal('fetch', fetch);
    const props = { id: purchaseId, basket, onExpired: vi.fn() };
    const { rerender } = render(<PurchaseSummary {...props} />);
    fetch.mockImplementationOnce(async () => json({}, 401));
    rerender(<PurchaseSummary {...props} basket={{ ...basket }} />);
    await waitFor(() => expect(props.onExpired).toHaveBeenCalled());
    await act(async () => { resolve(json(purchaseFixture())); });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(screen.queryByLabelText('Resultado de alternativas')).not.toBeInTheDocument();
  });
  it('shows cent savings, expensive pins, shared combo charged once and ambiguous receipts', async () => {
    mount();
    await screen.findByText('Más barata entre las opciones verificadas');
    expect(screen.getByText(/Ahorro frente a referencia: S\/ 0.01/)).toBeInTheDocument();
    expect(screen.getByText(/Tu elección · opciones elegidas por ti:/)).toBeInTheDocument();
    expect(screen.getByText(/1 × Producto seguido .*5.01/)).toBeInTheDocument();
    expect(screen.getByText('Correo: Entrega incierta')).toBeInTheDocument();
    await userEvent.click(screen.getByText('Ver recibo de email'));
    expect(screen.getByText(/"status": "ambiguous"/)).toBeInTheDocument();
  });
  it('publishes exact CAS and explicit projection, then hides stale results', async () => {
    const { fetch } = mount();
    await screen.findByLabelText('Nombre de necesidad 1');
    fireEvent.change(screen.getByLabelText('Nombre de necesidad 1'), { target: { value: 'Agua para viaje' } });
    action('Guardar cambios');
    fireEvent.click(screen.getByRole('button', { name: '3. Combos y preferencias' }));
    fireEvent.click(screen.getByLabelText('Usar siempre Combo fijado'));
    await userEvent.click(action('Guardar cambios'));
    await screen.findByText(/Cambios guardados/);
    const body = JSON.parse(String(fetch.mock.calls.find(([, o]) => o?.method === 'PUT')![1]!.body));
    expect(body.expected_version).toBe('9007199254740993');
    expect(body.configuration.needs[0].name).toBe('Agua para viaje');
    expect(body.configuration.pins).toEqual([]);
    expect(body.configuration).not.toHaveProperty('version');
    expect(screen.queryByText('Más barata entre las opciones verificadas')).not.toBeInTheDocument();
    expect(screen.getByText(/Sin resultado vigente/)).toBeInTheDocument();
  });
  it.each(['conflict', 'lost'] as const)('blocks retry after %s and preserves draft until explicit reconciliation', async mode => {
    const { fetch } = mount(mode);
    await screen.findByLabelText('Nombre de necesidad 1');
    fireEvent.change(screen.getByLabelText('Nombre de necesidad 1'), { target: { value: 'Borrador propio' } });
    await userEvent.click(action('Guardar cambios'));
    await screen.findByText(/Guardado bloqueado/);
    expect(action('Guardar cambios')).toBeDisabled();
    await userEvent.click(screen.getByRole('button', { name: 'Actualizar resultado' }));
    await screen.findByText(mode === 'conflict' ? /Resultado actualizado/ : /Nueva versión disponible/);
    expect(screen.getByLabelText('Nombre de necesidad 1')).toHaveValue('Borrador propio');
    expect(fetch.mock.calls.filter(([, o]) => o?.method === 'PUT')).toHaveLength(1);
    if (mode === 'lost') {
      expect(action('Guardar cambios')).toBeDisabled();
      await userEvent.click(action('Descartar borrador y cargar versión guardada'));
    }
    expect(action('Guardar cambios')).toBeEnabled();
  });
  it('allows adding needs, offers, combos and extras without publishing or activating', async () => {
    const { fetch } = mount(); await screen.findByLabelText('Nombre de necesidad 1');
    for (const name of ['Añadir necesidad', 'Añadir oferta', 'Añadir alternativa o combo', 'Añadir extra a oferta 1']) await userEvent.click(action(name));
    expect(screen.getByLabelText('Nombre de necesidad 3')).toHaveValue('Nueva necesidad');
    expect(screen.getByLabelText('Producto de oferta 3')).toBeInTheDocument();
    expect(screen.getByLabelText('Nombre de alternativa 3')).toBeInTheDocument();
    expect(screen.getByLabelText('Aceptar extra Nuevo extra')).not.toBeChecked();
    expect(fetch.mock.calls.every(([, o]) => o?.method !== 'PUT')).toBe(true);
  });
  it('keeps invalid pin and pending needs explicit without inventing a total or percentage', () => {
    const d = purchaseFixture(); const r = d.latest_evaluation!.snapshot.result;
    r.effective = { ...r.effective, invalidPin: true, coverageComplete: false, comparisonComplete: false, searchComplete: false, total: null, pendingNeedIds: [uid(1)] };
    r.recommendationSavings = { amount: null, percent: null }; r.recommendation.searchComplete = false;
    r.exclusions = [{ alternativeId: uid(8), reason: 'pending_failure' }];
    render(<PurchaseResults data={d} />);
    expect(screen.getByText(/La opción que elegiste no puede completar la compra/)).toBeInTheDocument();
    expect(screen.getByText('Pendiente de cubrir')).toBeInTheDocument();
    expect(screen.getByText('Los avisos de presupuesto quedan suspendidos hasta completar la compra y su comparación.')).toBeInTheDocument();
    expect(screen.getByText(/Combo fijado: Última revisión fallida/)).toBeInTheDocument();
    expect(screen.getByText(/Ahorro frente a referencia: Sin importe confirmado/)).toBeInTheDocument();
  });
  it('rejects cross-version results and projects away canonical metadata', async () => {
    const d = purchaseFixture(); d.latest_evaluation!.snapshot.configuration_version = '1';
    vi.stubGlobal('fetch', vi.fn(async () => json(d)));
    await expect(readPurchases(purchaseId)).rejects.toThrow('no válida');
    const c = purchaseFixture().configuration!;
    Object.assign(c.needs[0], { created_at: 'old', legacy_item_id: uid(1) });
    expect(publication(c).needs[0]).not.toHaveProperty('created_at');
  });
  it('shows recommendation and savings in basket list even below the notification threshold', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json(purchaseFixture())));
    render(<PurchaseSummary id={purchaseId} basket={{ budget: 6, currency: 'PEN', total: null, complete: false, product_count: 2, valid_count: 0 }} onExpired={vi.fn()} />);
    expect(await screen.findByText(/Ahorro frente a referencia: S\/ 0.01/)).toBeInTheDocument();
  });
  it('loads receipts without re-publishing and handles expired sessions', async () => {
    const d = purchaseFixture(); d.has_more = true;
    const fetch = vi.fn(async (url: string) => url === '/api/products' ? json({ products: [] }) : url.endsWith('page=1') ? json({ ...d, events: [{ ...d.events[0], id: uid(30), version: '1' }], has_more: false }) : json(d));
    vi.stubGlobal('fetch', fetch);
    const onExpired = vi.fn(); render(<PurchaseBasketScreen id={purchaseId} onExpired={onExpired} onBack={vi.fn()} />);
    await screen.findByRole('button', { name: 'Cargar más recibos', hidden: true });
    await userEvent.click(action('Cargar más recibos'));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Cargar más recibos' })).not.toBeInTheDocument());
    expect(screen.getAllByText('Correo: Entrega incierta')).toHaveLength(2);
    fetch.mockImplementation(async () => json({}, 401));
    await userEvent.click(screen.getByRole('button', { name: 'Actualizar resultado' }));
    await waitFor(() => expect(onExpired).toHaveBeenCalled());
  });
});
