import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';

interface InstallPrompt extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

type PwaInstallState = {
  installed: boolean;
  help: boolean;
  busy: boolean;
  error: string;
  install: () => Promise<void>;
};

const PwaInstallContext = createContext<PwaInstallState | null>(null);

function isInstalled() {
  return window.matchMedia?.('(display-mode: standalone)').matches
    || Boolean((navigator as Navigator & { standalone?: boolean }).standalone);
}

export function PwaInstallProvider({ children }: { children: ReactNode }) {
  const [installed, setInstalled] = useState(isInstalled);
  const [installPrompt, setInstallPrompt] = useState<InstallPrompt>();
  const [help, setHelp] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    const prompt = (event: Event) => { event.preventDefault(); setInstallPrompt(event as InstallPrompt); };
    const complete = () => { setInstalled(true); setHelp(false); setInstallPrompt(undefined); };
    const display = window.matchMedia?.('(display-mode: standalone)');
    const mode = () => setInstalled(isInstalled());
    window.addEventListener('beforeinstallprompt', prompt);
    window.addEventListener('appinstalled', complete);
    display?.addEventListener('change', mode);
    return () => {
      window.removeEventListener('beforeinstallprompt', prompt);
      window.removeEventListener('appinstalled', complete);
      display?.removeEventListener('change', mode);
    };
  }, []);

  async function install() {
    if (!installPrompt) { setHelp(value => !value); return; }
    setBusy(true); setError('');
    try {
      await installPrompt.prompt();
      const choice = await installPrompt.userChoice;
      if (choice.outcome === 'accepted') setHelp(false);
    } catch { setError('No pudimos abrir la instalación. Usa el menú de tu navegador.'); }
    finally { setInstallPrompt(undefined); setBusy(false); }
  }

  return <PwaInstallContext.Provider value={{ installed, help, busy, error, install }}>{children}</PwaInstallContext.Provider>;
}

export function usePwaInstall() {
  const state = useContext(PwaInstallContext);
  if (!state) throw new Error('usePwaInstall must be used inside PwaInstallProvider');
  return state;
}
