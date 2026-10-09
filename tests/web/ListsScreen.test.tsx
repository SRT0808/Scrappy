import { StrictMode } from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { App } from '../../src/App';
import { ListsScreen } from '../../src/components/ListsScreen';
import { requestLists } from '../../src/lib/lists';

const first = { id: '11111111-1111-4111-8111-111111111111', name: 'Tecnología', emoji: null, position: 0, created_at: '2026-10-08' };
const second = { ...first, id: '22222222-2222-4222-8222-222222222222', name: 'Hogar', position: 1 };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

function mock(...responses: (Response | Error)[]) {
  const fetch = vi.fn();
  for (const response of responses) {
    if (response instanceof Response) fetch.mockResolvedValueOnce(response);
    else fetch.mockRejectedValueOnce(response);
  }
  vi.stubGlobal('fetch', fetch);
  return fetch;
}

function mount() {
  const onExpired = vi.fn();
  render(<ListsScreen onExpired={onExpired} onLogout={vi.fn()} sessionBusy={false} sessionError="" />);
  return onExpired;
}

describe('lists screen', () => {
  it('lists, creates, renames, reorders in both directions and deletes after confirmation', async () => {
    const renamed = { ...second, name: 'Casa' };
    const fetch = mock(json({ lists: [first] }), json({ list: second }), json({ list: renamed }),
      json({ lists: [{ ...renamed, position: 0 }, { ...first, position: 1 }] }),
      json({ lists: [first, renamed] }), json({ deleted: true }));
    mount();
    const user = userEvent.setup();
    await screen.findByRole('heading', { name: first.name });
    expect(screen.getByRole('button', { name: 'Subir Tecnología' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Bajar Tecnología' })).toBeDisabled();
    await user.type(screen.getByLabelText('Nombre de la nueva lista'), ' Hogar ');
    await user.click(screen.getByRole('button', { name: 'Crear lista' }));
    await screen.findByRole('heading', { name: 'Hogar' });
    await user.click(screen.getByRole('button', { name: 'Renombrar Hogar' }));
    await user.clear(screen.getByLabelText('Nuevo nombre'));
    await user.type(screen.getByLabelText('Nuevo nombre'), 'Casa');
    await user.click(screen.getByRole('button', { name: 'Guardar nombre' }));
    await screen.findByRole('heading', { name: 'Casa' });
    await user.click(screen.getByRole('button', { name: 'Subir Casa' }));
    await waitFor(() => expect(screen.getAllByRole('listitem')[0]).toHaveTextContent('Casa'));
    await user.click(screen.getByRole('button', { name: 'Bajar Casa' }));
    await waitFor(() => expect(screen.getAllByRole('listitem')[0]).toHaveTextContent('Tecnología'));
    await user.click(screen.getByRole('button', { name: 'Eliminar Casa' }));
    expect(fetch).toHaveBeenCalledTimes(5);
    await user.click(screen.getByRole('button', { name: 'Cancelar eliminación' }));
    expect(screen.queryByRole('button', { name: 'Confirmar eliminación' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Eliminar Casa' }));
    await user.click(screen.getByRole('button', { name: 'Confirmar eliminación' }));
    await waitFor(() => expect(screen.queryByRole('heading', { name: 'Casa' })).not.toBeInTheDocument());
    expect(fetch.mock.calls.map(call => [call[0], call[1].method])).toEqual([
      ['/api/lists', 'GET'], ['/api/lists', 'POST'], [`/api/lists/${second.id}`, 'PATCH'],
      ['/api/lists/reorder', 'PUT'], ['/api/lists/reorder', 'PUT'], [`/api/lists/${second.id}`, 'DELETE'],
    ]);
    expect(JSON.parse(fetch.mock.calls[1][1].body)).toEqual({ name: 'Hogar' });
    expect(JSON.parse(fetch.mock.calls[2][1].body)).toEqual({ name: 'Casa' });
    expect(JSON.parse(fetch.mock.calls[3][1].body)).toEqual({ ids: [second.id, first.id] });
    expect(JSON.parse(fetch.mock.calls[4][1].body)).toEqual({ ids: [first.id, second.id] });
    for (const [, options] of fetch.mock.calls) expect(options).toMatchObject({ credentials: 'same-origin', cache: 'no-store' });
  });

  it('shows loading and empty states and validates trimmed Unicode name limits', async () => {
    const fetch = mock(json({ lists: [] }), json({ list: { ...first, name: '😀'.repeat(100) } }));
    mount();
    expect(screen.getByRole('status')).toHaveTextContent('cargando');
    await screen.findByText('Tu primera lista empieza aquí');
    const input = screen.getByLabelText('Nombre de la nueva lista');
    for (const name of ['   ', '😀'.repeat(101)]) {
      fireEvent.change(input, { target: { value: name } });
      fireEvent.submit(input.closest('form')!);
      expect(screen.getByRole('alert')).toHaveTextContent('1 a 100');
      expect(fetch).toHaveBeenCalledTimes(1);
    }
    fireEvent.change(input, { target: { value: '😀'.repeat(100) } });
    fireEvent.submit(input.closest('form')!);
    await screen.findByText('Cambio guardado.');
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('retains a list containing products and reports a safe conflict message', async () => {
    mock(json({ lists: [first] }), json({ error: 'private details' }, 409));
    mount();
    await screen.findByText(first.name);
    await userEvent.click(screen.getByRole('button', { name: 'Eliminar Tecnología' }));
    await userEvent.click(screen.getByRole('button', { name: 'Confirmar eliminación' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('contiene productos');
    expect(screen.getByRole('heading', { name: first.name })).toBeInTheDocument();
    expect(screen.queryByText('private details')).not.toBeInTheDocument();
  });

  it.each([404, 409, 0])('preserves order after failure %i and requires refresh before another mutation', async status => {
    const fetch = mock(json({ lists: [first, second] }), status ? json({}, status) : new TypeError('network'), json({ lists: [second, first] }));
    mount();
    await screen.findByText(first.name);
    await userEvent.click(screen.getByRole('button', { name: 'Subir Hogar' }));
    await screen.findByRole('alert');
    expect(screen.getAllByRole('listitem')[0]).toHaveTextContent(first.name);
    expect(screen.getByRole('button', { name: 'Crear lista' })).toBeDisabled();
    await userEvent.click(screen.getByRole('button', { name: 'Actualizar listas' }));
    await waitFor(() => expect(screen.getAllByRole('listitem')[0]).toHaveTextContent(second.name));
    expect(screen.getByRole('button', { name: 'Crear lista' })).toBeEnabled();
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it('retries a failed initial load and keeps editing values after server rejection', async () => {
    mock(json({}, 503), json({ lists: [first] }), json({}, 400));
    mount();
    await screen.findByRole('alert');
    expect(screen.getByRole('button', { name: 'Crear lista' })).toBeDisabled();
    await userEvent.click(screen.getByRole('button', { name: 'Actualizar listas' }));
    await screen.findByText(first.name);
    await userEvent.click(screen.getByRole('button', { name: 'Renombrar Tecnología' }));
    const input = screen.getByLabelText('Nuevo nombre');
    fireEvent.change(input, { target: { value: 'Nuevo' } });
    fireEvent.submit(input.closest('form')!);
    await screen.findByRole('alert');
    expect(input).toHaveValue('Nuevo');
    expect(screen.getByRole('heading', { name: first.name })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Cancelar' }));
    expect(screen.getByLabelText('Nombre de la nueva lista')).toHaveValue('');
  });

  it('blocks simultaneous mutations and logout while saving', async () => {
    let finish!: (response: Response) => void;
    const fetch = mock(json({ lists: [] }));
    fetch.mockImplementationOnce(() => new Promise<Response>(resolve => { finish = resolve; }));
    mount();
    await screen.findByText('Tu primera lista empieza aquí');
    const input = screen.getByLabelText('Nombre de la nueva lista');
    fireEvent.change(input, { target: { value: first.name } });
    fireEvent.submit(input.closest('form')!);
    fireEvent.submit(input.closest('form')!);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(screen.getByRole('button', { name: 'Cerrar sesión' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Actualizar listas' })).toBeDisabled();
    expect(screen.queryByRole('heading', { name: first.name })).not.toBeInTheDocument();
    finish(json({ list: first }));
    await screen.findByRole('heading', { name: first.name });
  });

  it.each(['read', 'create'] as const)('returns to access on expired session during %s', async action => {
    mock(json({ authenticated: true }), ...(action === 'create' ? [json({ lists: [] })] : []), json({}, 401));
    render(<App />);
    if (action === 'create') {
      await screen.findByText('Tu primera lista empieza aquí');
      fireEvent.change(screen.getByLabelText('Nombre de la nueva lista'), { target: { value: first.name } });
      await userEvent.click(screen.getByRole('button', { name: 'Crear lista' }));
    }
    expect(await screen.findByLabelText('Clave de acceso')).toHaveValue('');
    expect(screen.getByRole('alert')).toHaveTextContent('Tu sesión ha caducado');
    expect(screen.queryByRole('heading', { name: 'Tus listas' })).not.toBeInTheDocument();
  });

  it('ignores abandoned reads in StrictMode', async () => {
    let finish!: (response: Response) => void;
    const fetch = mock();
    fetch.mockImplementationOnce(() => new Promise<Response>(resolve => { finish = resolve; }));
    fetch.mockResolvedValueOnce(json({ lists: [second] }));
    render(<StrictMode><ListsScreen onExpired={vi.fn()} onLogout={vi.fn()} sessionBusy={false} sessionError="" /></StrictMode>);
    await screen.findByRole('heading', { name: second.name });
    finish(json({ lists: [first] }));
    await waitFor(() => expect(fetch.mock.calls[0][1].signal.aborted).toBe(true));
    expect(screen.queryByRole('heading', { name: first.name })).not.toBeInTheDocument();
  });
});

describe('lists transport', () => {
  it.each([{}, { lists: [{}] }, { lists: [first, first] }])('rejects invalid successful payloads', async body => {
    mock(json(body));
    await expect(requestLists('read')).rejects.toThrow('No pudimos confirmar');
  });
  it('rejects HTML fallbacks, invalid deletion and mutation payloads', async () => {
    mock(new Response('<html/>'), json({ deleted: false }), json({ list: null }));
    await expect(requestLists('read')).rejects.toThrow('No pudimos confirmar');
    await expect(requestLists('delete', undefined, first.id)).rejects.toThrow('No pudimos confirmar');
    await expect(requestLists('create', { name: 'Test' })).rejects.toThrow('No pudimos confirmar');
  });
  it.each([403, 500, 503])('handles HTTP %i without rendering arbitrary server text', async status => {
    mock(json({ error: 'private details' }, status));
    await expect(requestLists('read')).rejects.toThrow(status === 403 ? 'validar' : 'servicio');
  });
  it('sets a finite timeout and treats ambiguous create failure as requiring refresh', async () => {
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    mock(new DOMException('Timeout', 'TimeoutError'));
    await expect(requestLists('create', { name: 'Test' })).rejects.toThrow('comprobar si el cambio se guardó');
    expect(timeout).toHaveBeenCalledWith(15_000);
  });
});
