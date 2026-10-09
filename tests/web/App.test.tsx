import { StrictMode } from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { App } from '../../src/App';
import { AuthError, requestAuth } from '../../src/lib/auth';

function response(status = 200, authenticated = true, headers: HeadersInit = {}) {
  return new Response(JSON.stringify({ authenticated }), { status, headers });
}

function mockRequests(...responses: (Response | Error)[]) {
  const fetch = vi.fn();
  for (const value of responses) {
    if (value instanceof Response) fetch.mockResolvedValueOnce(value);
    else fetch.mockRejectedValueOnce(value);
  }
  vi.stubGlobal('fetch', (url: string, options: RequestInit) => url === '/api/lists' ? Promise.resolve(new Response(JSON.stringify({ lists: [] }))) : fetch(url, options));
  return fetch;
}

async function enterKey(key = 'private-test-key') {
  const user = userEvent.setup();
  await user.type(await screen.findByLabelText('Clave de acceso'), key);
  await user.click(screen.getByRole('button', { name: 'Entrar' }));
  return user;
}

describe('access screen', () => {
  it('checks the session before exposing the form or workspace', async () => {
    let finish!: (response: Response) => void;
    const fetch = vi.fn(() => new Promise<Response>(resolve => { finish = resolve; }));
    vi.stubGlobal('fetch', fetch);
    render(<App />);
    expect(screen.getByRole('status')).toHaveTextContent('Comprobando');
    expect(screen.queryByLabelText('Clave de acceso')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Cerrar sesión' })).not.toBeInTheDocument();
    finish(response(401));
    await screen.findByLabelText('Clave de acceso');
    await waitFor(() => expect(screen.getByLabelText('Clave de acceso')).toHaveFocus());
    expect(fetch).toHaveBeenCalledWith('/api/session', expect.objectContaining({
      method: 'GET', credentials: 'same-origin', cache: 'no-store',
    }));
  });

  it('logs in with the exact key, confirms the cookie, restores on reload and logs out', async () => {
    const fetch = mockRequests(response(401), response(), response(), response(), response(200, false));
    const first = render(<App />);
    const user = await enterKey(' test-key ');
    expect(await screen.findByRole('heading', { name: 'Tus listas' })).toBeInTheDocument();
    expect(fetch).toHaveBeenNthCalledWith(2, '/api/login', expect.objectContaining({
      method: 'POST', credentials: 'same-origin', cache: 'no-store',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: ' test-key ' }),
    }));
    expect(fetch.mock.calls[2][0]).toBe('/api/session');
    expect(localStorage.length).toBe(0);
    expect(sessionStorage.length).toBe(0);
    first.unmount();
    render(<App />);
    await user.click(await screen.findByRole('button', { name: 'Cerrar sesión' }));
    expect(await screen.findByLabelText('Clave de acceso')).toHaveValue('');
    expect(fetch).toHaveBeenLastCalledWith('/api/logout', expect.objectContaining({ method: 'POST', credentials: 'same-origin' }));
  });

  it('clears a rejected key, focuses the field and permits another attempt', async () => {
    mockRequests(response(401), response(401), response(), response());
    render(<App />);
    await enterKey();
    expect(await screen.findByRole('alert')).toHaveTextContent('Clave incorrecta');
    expect(screen.getByLabelText('Clave de acceso')).toHaveValue('');
    await waitFor(() => expect(screen.getByLabelText('Clave de acceso')).toHaveFocus());
    await enterKey('new-key');
    expect(await screen.findByRole('button', { name: 'Cerrar sesión' })).toBeInTheDocument();
  });

  it('shows the server rate-limit wait without displaying its raw body', async () => {
    mockRequests(response(401), new Response(JSON.stringify({ error: 'sensitive arbitrary details' }), { status: 429, headers: { 'Retry-After': '61' } }));
    render(<App />);
    await enterKey();
    expect(await screen.findByRole('alert')).toHaveTextContent('Espera 2 minutos');
    expect(screen.queryByText(/sensitive arbitrary/)).not.toBeInTheDocument();
  });

  it('does not expose the workspace when the login cookie is rejected', async () => {
    mockRequests(response(401), response(), response(401));
    render(<App />);
    await enterKey();
    expect(await screen.findByRole('alert')).toHaveTextContent('Tu sesión ha caducado');
    expect(screen.queryByRole('button', { name: 'Cerrar sesión' })).not.toBeInTheDocument();
  });

  it('keeps a restoration failure separate from an expired session and retries', async () => {
    mockRequests(response(503), response());
    render(<App />);
    expect(await screen.findByRole('alert')).toHaveTextContent('El servicio no está disponible');
    expect(screen.queryByLabelText('Clave de acceso')).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Reintentar conexión' }));
    expect(await screen.findByRole('button', { name: 'Cerrar sesión' })).toBeInTheDocument();
  });

  it('reports network errors and clears the submitted key', async () => {
    mockRequests(response(401), new TypeError('Failed to fetch'));
    render(<App />);
    await enterKey();
    expect(await screen.findByRole('alert')).toHaveTextContent('Comprueba tu conexión');
    expect(screen.getByLabelText('Clave de acceso')).toHaveValue('');
  });

  it('keeps the session after failed logout and handles an already expired session', async () => {
    mockRequests(response(), response(503), response(401));
    render(<App />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Cerrar sesión' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('El servicio no está disponible');
    expect(screen.getByRole('heading', { name: 'Tus listas' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Cerrar sesión' }));
    expect(await screen.findByLabelText('Clave de acceso')).toHaveFocus();
  });

  it('rejects a Unicode key exceeding the byte limit without sending it', async () => {
    const fetch = mockRequests(response(401));
    render(<App />);
    fireEvent.change(await screen.findByLabelText('Clave de acceso'), { target: { value: 'á'.repeat(513) } });
    await userEvent.click(screen.getByRole('button', { name: 'Entrar' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('máximo 1024 bytes');
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('prevents duplicate submissions while login is pending', async () => {
    let finish!: (response: Response) => void;
    const fetch = mockRequests(response(401));
    fetch.mockImplementationOnce(() => new Promise<Response>(resolve => { finish = resolve; }));
    fetch.mockResolvedValueOnce(response());
    render(<App />);
    await enterKey();
    const input = screen.getByLabelText('Clave de acceso');
    expect(input).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Entrando…' })).toBeDisabled();
    fireEvent.submit(input.closest('form')!);
    expect(fetch).toHaveBeenCalledTimes(2);
    finish(response());
    expect(await screen.findByRole('button', { name: 'Cerrar sesión' })).toBeInTheDocument();
  });

  it('ignores an abandoned restoration in StrictMode', async () => {
    let finish!: (response: Response) => void;
    const fetch = vi.fn()
      .mockImplementationOnce(() => new Promise<Response>(resolve => { finish = resolve; }))
      .mockResolvedValueOnce(response(401));
    vi.stubGlobal('fetch', fetch);
    render(<StrictMode><App /></StrictMode>);
    expect(await screen.findByLabelText('Clave de acceso')).toBeInTheDocument();
    finish(response());
    await waitFor(() => expect(fetch.mock.calls[0][1].signal.aborted).toBe(true));
    expect(screen.queryByRole('button', { name: 'Cerrar sesión' })).not.toBeInTheDocument();
  });
});

describe('authentication transport', () => {
  it.each([new Response('<html>fallback</html>'), response(200, false)])('rejects malformed or unsuccessful session confirmations', async value => {
    mockRequests(value);
    await expect(requestAuth('session')).rejects.toThrow('No pudimos confirmar la sesión');
  });

  it('uses a finite timeout and reports timeout failures', async () => {
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    const fetch = mockRequests(new DOMException('Timeout', 'TimeoutError'));
    await expect(requestAuth('login', 'test-key')).rejects.toThrow('Comprueba tu conexión');
    expect(fetch.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
    expect(timeout).toHaveBeenCalledWith(15_000);
  });

  it.each([400, 403, 429, 500, 503])('treats HTTP %i as an error', async status => {
    mockRequests(response(status));
    await expect(requestAuth('login', 'test-key')).rejects.toBeInstanceOf(AuthError);
  });
});
