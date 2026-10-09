import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { SettingsScreen } from '../../src/components/SettingsScreen';
import { HomeScreen } from '../../src/components/HomeScreen';
import { AddProduct } from '../../src/components/AddProduct';
import { loadSettings, sendTest } from '../../src/lib/settings';

const empty = { default_interval_hours: 6, last_run: null, notifications: [], has_more: false };
const json = (body: unknown, status = 200) => Response.json(body, { status });
function mount() {
  const onExpired = vi.fn(); const onBack = vi.fn();
  render(<SettingsScreen onExpired={onExpired} onBack={onBack} />);
  return { onExpired, onBack };
}
describe('settings', () => {
  it('loads empty states, saves interval without touching products and returns home', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(json(empty)).mockResolvedValueOnce(json({ default_interval_hours: 12 }));
    vi.stubGlobal('fetch', fetch); const { onBack } = mount();
    expect(screen.getByRole('status')).toHaveTextContent('Cargando');
    await screen.findByText('Todavía no hay ejecuciones registradas.');
    expect(screen.getByText(/Aún no hay notificaciones/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Intervalo por defecto'), { target: { value: '12' } });
    fireEvent.click(screen.getByRole('button', { name: 'Guardar intervalo' }));
    await screen.findByText(/Intervalo guardado/);
    expect(fetch.mock.calls[1]).toEqual(['/api/settings', expect.objectContaining({ method: 'PATCH', body: '{"default_interval_hours":12}' })]);
    expect(screen.getByRole('button', { name: 'Guardar intervalo' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Volver a Inicio' })); expect(onBack).toHaveBeenCalledOnce();
  });
  it('shows run status and paginates notification history', async () => {
    const run = { id: 'run', started_at: '2026-10-09T01:00:00Z', finished_at: '2026-10-09T02:00:00Z', trigger: 'cron', checked: 2, ok_count: 1, fail_count: 1 };
    const fetch = vi.fn().mockResolvedValueOnce(json({ ...empty, last_run: run, has_more: true, notifications: [{ id: 'one', type: 'test', channel: 'ntfy', status: 'failed', sent_at: run.started_at, title: 'Prueba anterior', error: 'No se pudo enviar por ntfy.' }] })).mockResolvedValueOnce(json(empty));
    vi.stubGlobal('fetch', fetch); mount();
    await screen.findByText('Finalizada con errores'); expect(screen.getByText('2 revisados · 1 correctos · 1 fallidos')).toBeInTheDocument();
    expect(screen.getByText('Fallida')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Siguiente' }));
    await waitFor(() => expect(fetch).toHaveBeenLastCalledWith('/api/settings?page=1', expect.anything()));
    await screen.findByText(/Aún no hay notificaciones/); expect(screen.getByText('Página 2')).toBeInTheDocument();
  });
  it('disables duplicate sends, shows each channel result and refreshes history', async () => {
    let finish!: (value: Response) => void;
    const fetch = vi.fn().mockResolvedValueOnce(json(empty)).mockImplementationOnce(() => new Promise<Response>(resolve => { finish = resolve; })).mockResolvedValueOnce(json(empty));
    vi.stubGlobal('fetch', fetch); mount(); await screen.findByLabelText('Intervalo por defecto');
    const button = screen.getByRole('button', { name: 'Enviar notificación de prueba' });
    fireEvent.click(button); fireEvent.click(button); expect(button).toBeDisabled(); expect(fetch).toHaveBeenCalledTimes(2);
    finish(json({ deliveries: [{ channel: 'ntfy', status: 'failed', recorded: true }, { channel: 'email', status: 'sent', recorded: false }] }));
    await screen.findByText('ntfy: falló el envío.');
    expect(screen.getByText(/Correo: enviada.*No se pudo registrar/)).toBeInTheDocument();
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(3));
  });
  it('handles expiry and retries failed loads', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(json({}, 503)).mockResolvedValueOnce(json({}, 401));
    vi.stubGlobal('fetch', fetch); const { onExpired } = mount();
    await screen.findByRole('alert'); fireEvent.click(screen.getByRole('button', { name: 'Reintentar consulta' }));
    await waitFor(() => expect(onExpired).toHaveBeenCalledWith(expect.stringContaining('caducado')));
  });
  it('does not repeat a send after a network error', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(json(empty)).mockRejectedValueOnce(new Error('secret'));
    vi.stubGlobal('fetch', fetch); mount(); await screen.findByLabelText('Intervalo por defecto');
    fireEvent.click(screen.getByRole('button', { name: 'Enviar notificación de prueba' }));
    await screen.findByRole('alert'); expect(screen.getByRole('alert')).toHaveTextContent('Actualiza el historial'); expect(fetch).toHaveBeenCalledTimes(2);
  });
  it('opens Ajustes from Inicio', async () => {
    vi.stubGlobal('fetch', vi.fn((url: string) => Promise.resolve(json(url === '/api/lists' ? { lists: [] } : empty))));
    render(<HomeScreen onExpired={vi.fn()} onLogout={vi.fn()} sessionBusy={false} sessionError="" />);
    fireEvent.click(screen.getByRole('button', { name: 'Ajustes' }));
    await screen.findByLabelText('Intervalo por defecto'); expect(document.title).toBe('Scrappy · Ajustes');
  });
  it('applies persisted interval to a new product reading', async () => {
    const id = '11111111-1111-4111-8111-111111111111';
    vi.stubGlobal('fetch', vi.fn((url: string) => Promise.resolve(json(url.startsWith('/api/settings') ? { default_interval_hours: 24 }
      : { reading: { id, url: 'https://shop.pe/product', status: 'ready', result: { name: 'Monitor', price: '100.00', original_price: null, currency: 'PEN', image_url: null, method: 'json_ld', confidence: 0.98, candidates: [], warnings: [] }, product_id: null, created_at: '2026-10-09T00:00:00Z' } }))));
    vi.spyOn(crypto, 'randomUUID').mockReturnValue(id);
    render(<AddProduct lists={[{ id, name: 'Lista', emoji: null, position: 0, created_at: '2026-10-09' }]} onExpired={vi.fn()} onClose={vi.fn()} onSaved={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('URL del producto'), { target: { value: 'https://shop.pe/product' } });
    fireEvent.click(screen.getByRole('button', { name: 'Leer producto' }));
    await screen.findByRole('heading', { name: 'Confirma lo que encontramos' });
    expect(screen.getByLabelText('Intervalo de revisión')).toHaveValue('24');
  });
  it('rejects malformed settings and ambiguous delivery confirmations', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(json({ ...empty, default_interval_hours: 5 })).mockResolvedValueOnce(json({ deliveries: [{ channel: 'ntfy', status: 'sent', recorded: true }, { channel: 'ntfy', status: 'sent', recorded: true }] })));
    await expect(loadSettings(0)).rejects.toThrow('no es válida'); await expect(sendTest()).rejects.toThrow('confirmar');
  });
});
