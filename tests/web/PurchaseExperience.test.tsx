import { useState } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { PurchaseBasketScreen } from '../../src/components/PurchaseBasketScreen';
import { PurchaseOptionBuilder } from '../../src/components/PurchaseOptionBuilder';
import { HomeScreen } from '../../src/components/HomeScreen';
import { purchaseFixture, purchaseId, uid } from '../fixtures/purchase-ui';
import type { Configuration } from '../../src/lib/purchases';
import type { ProductSummary } from '../../src/lib/products';
import { basketDetail } from '../fixtures/basket-experience';

const product: ProductSummary = { id: uid(50), name: 'Botella 500 ml', url: 'https://shop.example/water', domain: 'shop.example', image_url: null,
  currency: 'PEN', reference_price: 3, target_type: null, target_price: null, target_percent: null, last_price: 1.3, status: 'active',
  created_at: '2026-10-18', last_checked_at: null, last_success_at: null, history: [], list_id: null };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
function mock() {
  const fetch = vi.fn(async (url: string, options?: RequestInit) => url === '/api/products' ? json({ products: [product] })
    : url === '/api/lists' ? json({ lists: [{ id: purchaseId, name: 'Mi compra', position: 0, emoji: null, created_at: '2026-10-18' }] })
      : url.includes('/purchases') ? options?.method === 'PUT' ? json({}, 400) : json(purchaseFixture())
        : json({ detail: { ...basketDetail, id: purchaseId } }));
  vi.stubGlobal('fetch', fetch); return fetch;
}

describe('purchase experience', () => {
  it('starts with the named summary, then exposes each editor step without publishing', async () => {
    const fetch = mock();
    render(<PurchaseBasketScreen id={purchaseId} name="Skincare" onBack={vi.fn()} onExpired={vi.fn()} />);
    await screen.findByRole('button', { name: 'Editar mi compra' });
    expect(screen.getByRole('heading', { name: 'Skincare' })).toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: 'Nombre de necesidad 1' })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Editar mi compra' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Nombre de necesidad 1' }), { target: { value: 'Agua para viaje' } });
    await userEvent.click(screen.getByRole('button', { name: '2. Opciones de compra' }));
    expect(screen.getByRole('button', { name: 'Añadir opción de compra' })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: '3. Combos y preferencias' }));
    expect(screen.getByRole('checkbox', { name: 'Usar siempre Combo fijado' })).toBeChecked();
    await userEvent.click(screen.getByRole('button', { name: '4. Presupuesto y avisos' }));
    expect(screen.getByRole('checkbox', { name: 'Avisar cambio de ganador' })).toBeChecked();
    await userEvent.click(screen.getByRole('button', { name: '1. Qué necesitas' }));
    expect(screen.getByRole('textbox', { name: 'Nombre de necesidad 1' })).toHaveValue('Agua para viaje');
    expect(fetch.mock.calls.some(([, o]) => o?.method === 'PUT')).toBe(false);
  });

  it('creates an exact simple option and leaves existing combos, pins and references intact', async () => {
    let latest: Configuration = purchaseFixture().configuration!;
    function Editor() { const [c, setC] = useState(latest); return <PurchaseOptionBuilder configuration={c} products={[product]} onChange={value => { latest = value; setC(value); }} />; }
    const original = structuredClone(latest); render(<Editor />);
    await userEvent.selectOptions(screen.getByLabelText('Producto que comprarías'), product.id);
    fireEvent.change(screen.getByLabelText('Contenido por presentación (ml)'), { target: { value: '500' } });
    fireEvent.change(screen.getByLabelText('Cuántas comprarías'), { target: { value: '2' } });
    await userEvent.click(screen.getByRole('button', { name: 'Añadir opción de compra' }));
    expect(latest.offers.at(-1)?.coverage).toEqual([{ need_id: uid(1), quantity: '500' }]);
    expect(latest.alternatives.at(-1)?.items[0].purchase_units).toBe(2);
    expect(latest.offers.slice(0, 2)).toEqual(original.offers);
    expect(latest.pins).toEqual(original.pins); expect(latest.reference).toEqual(original.reference);
    expect(latest.needs[0].allow_surplus).toBe(false);
  });

  it('rejects fractional purchases without altering the graph', async () => {
    const change = vi.fn(); render(<PurchaseOptionBuilder configuration={purchaseFixture().configuration!} products={[product]} onChange={change} />);
    await userEvent.selectOptions(screen.getByLabelText('Producto que comprarías'), product.id);
    fireEvent.change(screen.getByLabelText('Cuántas comprarías'), { target: { value: '1.5' } });
    await userEvent.click(screen.getByRole('button', { name: 'Añadir opción de compra' }));
    expect(screen.getByRole('alert')).toHaveTextContent('número entero'); expect(change).not.toHaveBeenCalled();
  });

  it('explains duplicate presentations and overlapping references without altering existing choices', async () => {
    const change = vi.fn(); const existingProduct = { ...product, id: uid(4) };
    render(<PurchaseOptionBuilder configuration={purchaseFixture().configuration!} products={[existingProduct, product]} onChange={change} />);
    await userEvent.selectOptions(screen.getByLabelText('Producto que comprarías'), existingProduct.id);
    await userEvent.click(screen.getByRole('button', { name: 'Añadir opción de compra' }));
    expect(screen.getByRole('alert')).toHaveTextContent('ya tiene una presentación');
    await userEvent.selectOptions(screen.getByLabelText('Producto que comprarías'), product.id);
    await userEvent.click(screen.getByRole('checkbox', { name: 'Incluir esta opción en mi compra de referencia' }));
    await userEvent.click(screen.getByRole('button', { name: 'Añadir opción de compra' }));
    expect(screen.getByRole('alert')).toHaveTextContent('referencia ya cubre'); expect(change).not.toHaveBeenCalled();
  });

  it('returns from adding a URL with the same unsaved configuration', async () => {
    mock(); render(<PurchaseBasketScreen id={purchaseId} onBack={vi.fn()} onExpired={vi.fn()} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Editar mi compra' }));
    fireEvent.change(screen.getByLabelText('Nombre de necesidad 1'), { target: { value: 'Mi borrador' } });
    await userEvent.click(screen.getByRole('button', { name: '2. Opciones de compra' }));
    await userEvent.click(screen.getByRole('button', { name: 'Añadir producto por enlace' }));
    expect(screen.getByRole('heading', { name: 'Añadir producto' })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Volver a mi compra' }));
    expect(screen.getByLabelText('Nombre de necesidad 1')).toHaveValue('Mi borrador');
  });

  it('keeps invalid input editable and protects reload and in-app departure', async () => {
    const previous = window.location.href; window.history.replaceState(null, '', `/?basket=${purchaseId}`);
    try {
      const fetch = mock(); render(<HomeScreen onExpired={vi.fn()} onLogout={vi.fn()} sessionBusy={false} sessionError="" />);
      await userEvent.click(await screen.findByRole('button', { name: 'Editar mi compra' }));
      fireEvent.change(screen.getByLabelText('Nombre de necesidad 1'), { target: { value: 'Borrador' } });
      const event = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(event); expect(event.defaultPrevented).toBe(true);
      await userEvent.click(screen.getByRole('button', { name: 'Guardar cambios' })); await screen.findByRole('alert');
      expect(screen.getByRole('button', { name: 'Guardar cambios' })).toBeEnabled();
      await userEvent.click(screen.getByRole('button', { name: 'Ir a Productos' })); expect(screen.getByRole('alertdialog')).toBeInTheDocument();
      await userEvent.click(screen.getByRole('button', { name: 'Seguir editando' })); expect(screen.getByLabelText('Nombre de necesidad 1')).toHaveValue('Borrador');
      await userEvent.click(screen.getByRole('button', { name: 'Ir a Productos' })); await userEvent.click(screen.getByRole('button', { name: 'Salir sin guardar' }));
      expect(await screen.findByRole('heading', { name: 'Productos' })).toBeInTheDocument();
      expect(fetch.mock.calls.filter(([, o]) => o?.method === 'PUT')).toHaveLength(1);
    } finally { window.history.replaceState(null, '', previous); }
  });

  it('reads historic compositions without exposing legacy mutations', async () => {
    const fetch = mock(); render(<PurchaseBasketScreen id={purchaseId} onBack={vi.fn()} onExpired={vi.fn()} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Ver historial de la canasta' }));
    expect(await screen.findByRole('heading', { name: 'Historial por composición' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Volver al resumen' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Guardar cantidad' })).not.toBeInTheDocument();
    expect(fetch.mock.calls.every(([, o]) => !o?.method || o.method === 'GET')).toBe(true);
  });
});
