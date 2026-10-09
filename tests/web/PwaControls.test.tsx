import { act, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PwaControls } from '../../src/components/PwaControls';

const pwa = vi.hoisted(() => ({ refresh: false, dismiss: vi.fn(), update: vi.fn() }));
vi.mock('virtual:pwa-register/react', () => ({
  useRegisterSW: () => ({ needRefresh: [pwa.refresh, pwa.dismiss], updateServiceWorker: pwa.update }),
}));

beforeEach(() => {
  pwa.refresh = false; pwa.dismiss.mockReset(); pwa.update.mockReset();
  vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true);
});

describe('PWA controls', () => {
  it('provides Android and iPhone instructions when no native prompt exists', async () => {
    render(<PwaControls />);
    await userEvent.click(screen.getByRole('button', { name: 'Instalar app' }));
    expect(screen.getByText(/Android:/)).toHaveTextContent('Chrome');
    expect(screen.getByText(/iPhone:/)).toHaveTextContent('Safari');
  });

  it.each(['accepted', 'dismissed'])('opens the native prompt once for outcome %s', async outcome => {
    render(<PwaControls />);
    const prompt = vi.fn().mockResolvedValue(undefined);
    const event = Object.assign(new Event('beforeinstallprompt', { cancelable: true }), {
      prompt, userChoice: Promise.resolve({ outcome }),
    });
    act(() => { window.dispatchEvent(event); });
    expect(event.defaultPrevented).toBe(true);
    await userEvent.click(screen.getByRole('button', { name: 'Instalar app' }));
    expect(prompt).toHaveBeenCalledTimes(1);
    await userEvent.click(screen.getByRole('button', { name: 'Instalar app' }));
    expect(prompt).toHaveBeenCalledTimes(1);
    expect(screen.getByText(/Android:/)).toBeInTheDocument();
  });

  it('hides install controls after installation and in standalone mode', () => {
    const view = render(<PwaControls />);
    act(() => { window.dispatchEvent(new Event('appinstalled')); });
    expect(screen.queryByRole('button', { name: 'Instalar app' })).not.toBeInTheDocument();
    view.unmount();
    vi.stubGlobal('matchMedia', () => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
    render(<PwaControls />);
    expect(screen.queryByRole('button', { name: 'Instalar app' })).not.toBeInTheDocument();
  });

  it('requires explicit consent to update and allows postponement', async () => {
    pwa.refresh = true;
    render(<PwaControls />);
    expect(pwa.update).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: 'Más tarde' }));
    expect(pwa.dismiss).toHaveBeenCalledWith(false);
    await userEvent.click(screen.getByRole('button', { name: 'Actualizar' }));
    expect(pwa.update).toHaveBeenCalledWith(true);
  });

  it('explains lost connectivity and disables updates until online', () => {
    pwa.refresh = true;
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    render(<PwaControls />);
    expect(screen.getByText(/Sin conexión/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Actualizar' })).toBeDisabled();
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true);
    fireEvent(window, new Event('online'));
    expect(screen.queryByText(/Sin conexión/)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Actualizar' })).toBeEnabled();
  });

  it('reports failed updates and allows retry', async () => {
    pwa.refresh = true;
    pwa.update.mockRejectedValueOnce(new Error('network'));
    render(<PwaControls />);
    await userEvent.click(screen.getByRole('button', { name: 'Actualizar' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('No pudimos actualizar');
    expect(screen.getByRole('button', { name: 'Actualizar' })).toBeEnabled();
  });
});
