import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { BasketSummary } from '../../src/components/BasketSummary';
import { ListsScreen } from '../../src/components/ListsScreen';
import { HomeScreen } from '../../src/components/HomeScreen';
import { isBasket, parseBudget } from '../../src/lib/baskets';
vi.mock('../../src/lib/purchases', async importOriginal => ({
  ...await importOriginal<typeof import('../../src/lib/purchases')>(),
  readPurchases: async (id: string) => ({ schema_version: 2, list_id: id, mode: 'legacy', version: '1', configuration: null, latest_evaluation: null, stale_reason: 'mode', events: [], has_more: false }),
}));

const basket = { budget: 100.10, currency: 'PEN', total: 100.10, product_count: 2, valid_count: 2, complete: true };
const list = { id: '11111111-1111-4111-8111-111111111111', name: 'Tecnología', emoji: null, position: 0, created_at: '2026-10-11', basket };
const props = { onExpired: vi.fn(), onLogout: vi.fn(), sessionBusy: false, sessionError: '' };
const json = (body: unknown) => new Response(JSON.stringify(body));

describe('basket MVP', () => {
  it('shows the exact boundary and marks a partial subtotal as incomplete', () => {
    const { rerender } = render(<BasketSummary basket={basket} />);
    expect(screen.getByText('Gasto objetivo alcanzado')).toBeInTheDocument();
    rerender(<BasketSummary basket={{ ...basket, total: 40.05, valid_count: 1, complete: false }} />);
    expect(screen.getByText('Canasta incompleta')).toBeInTheDocument();
    expect(screen.getByText(/Total estimado/)).toBeInTheDocument();
    expect(screen.getByText(/Sin aviso hasta completar/)).toBeInTheDocument();
    expect(screen.queryByText('Gasto objetivo alcanzado')).not.toBeInTheDocument();
  });

  it('saves and disables an optional basket independently of the list name', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(json({ lists: [{ ...list, basket: null }] }))
      .mockResolvedValueOnce(json({ list })).mockResolvedValueOnce(json({ list: { ...list, basket: null } }));
    vi.stubGlobal('fetch', fetch);
    render(<ListsScreen {...props} />);
    await screen.findByRole('heading', { name: list.name });
    await userEvent.click(screen.getByRole('button', { name: 'Configurar canasta de Tecnología' }));
    fireEvent.change(screen.getByLabelText('Gasto máximo'), { target: { value: '100,10' } });
    await userEvent.click(screen.getByRole('button', { name: 'Guardar canasta' }));
    await screen.findByText('Gasto objetivo alcanzado');
    expect(JSON.parse(fetch.mock.calls[1][1].body)).toEqual({ basket_budget: 100.10, basket_currency: 'PEN' });
    expect(fetch.mock.calls[1][1].method).toBe('PATCH');
    await userEvent.click(screen.getByRole('button', { name: 'Configurar canasta de Tecnología' }));
    await userEvent.click(screen.getByRole('button', { name: 'Desactivar canasta' }));
    await waitFor(() => expect(screen.queryByLabelText('Resumen de canasta')).not.toBeInTheDocument());
    expect(JSON.parse(fetch.mock.calls[2][1].body)).toEqual({ basket_budget: null, basket_currency: null });
  });

  it('does not save zero or fractional cents', async () => {
    const fetch = vi.fn().mockResolvedValue(json({ lists: [list] }));
    vi.stubGlobal('fetch', fetch);
    render(<ListsScreen {...props} />);
    await screen.findByRole('heading', { name: list.name });
    await userEvent.click(screen.getByRole('button', { name: 'Configurar canasta de Tecnología' }));
    for (const value of ['0', '1.001', '-1']) {
      fireEvent.change(screen.getByLabelText('Gasto máximo'), { target: { value } });
      await userEvent.click(screen.getByRole('button', { name: 'Guardar canasta' }));
      expect(screen.getByRole('alert')).toHaveTextContent('gasto máximo positivo');
    }
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('opens the detail without saving an open configuration form', async () => {
    const fetch = vi.fn().mockResolvedValue(json({ lists: [list] }));
    vi.stubGlobal('fetch', fetch);
    const onDetail = vi.fn();
    render(<ListsScreen {...props} onDetail={onDetail} />);
    await screen.findByRole('heading', { name: list.name });
    await userEvent.click(screen.getByRole('button', { name: 'Configurar canasta de Tecnología' }));
    fireEvent.change(screen.getByLabelText('Gasto máximo'), { target: { value: '200' } });
    await userEvent.click(screen.getByRole('button', { name: 'Ver canasta' }));
    expect(onDetail).toHaveBeenCalledWith(list.id);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('validates aggregate invariants and accepts Spanish decimal input', () => {
    expect(parseBudget('100,10')).toBe(100.10);
    expect(parseBudget('0')).toBeNull();
    expect(parseBudget('1.001')).toBeNull();
    expect(isBasket(basket)).toBe(true);
    expect(isBasket({ ...basket, total: Infinity })).toBe(false);
    expect(isBasket({ ...basket, product_count: 0, valid_count: 0 })).toBe(false);
    expect(isBasket({ ...basket, valid_count: 1 })).toBe(false);
  });
});
