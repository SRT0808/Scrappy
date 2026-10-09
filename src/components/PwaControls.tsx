import { useEffect, useState } from 'react';
import { useRegisterSW } from 'virtual:pwa-register/react';
import { Button } from './ui/button';

interface InstallPrompt extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

function isInstalled() {
  return window.matchMedia?.('(display-mode: standalone)').matches
    || Boolean((navigator as Navigator & { standalone?: boolean }).standalone);
}

export function PwaControls() {
  const [installed, setInstalled] = useState(isInstalled);
  const [installPrompt, setInstallPrompt] = useState<InstallPrompt>();
  const [help, setHelp] = useState(false);
  const [online, setOnline] = useState(navigator.onLine);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const { needRefresh: [needRefresh, setNeedRefresh], updateServiceWorker } = useRegisterSW({
    onRegisterError() { setError('No pudimos preparar la instalación. Comprueba tu conexión y vuelve a abrir la app.'); },
  });

  useEffect(() => {
    const prompt = (event: Event) => { event.preventDefault(); setInstallPrompt(event as InstallPrompt); };
    const complete = () => { setInstalled(true); setHelp(false); setInstallPrompt(undefined); };
    const connection = () => setOnline(navigator.onLine);
    const display = window.matchMedia?.('(display-mode: standalone)');
    const mode = () => setInstalled(isInstalled());
    window.addEventListener('beforeinstallprompt', prompt);
    window.addEventListener('appinstalled', complete);
    window.addEventListener('online', connection);
    window.addEventListener('offline', connection);
    display?.addEventListener('change', mode);
    return () => {
      window.removeEventListener('beforeinstallprompt', prompt);
      window.removeEventListener('appinstalled', complete);
      window.removeEventListener('online', connection);
      window.removeEventListener('offline', connection);
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

  async function update() {
    setBusy(true); setError('');
    try { await updateServiceWorker(true); }
    catch { setError('No pudimos actualizar. Comprueba tu conexión y vuelve a intentarlo.'); }
    finally { setBusy(false); }
  }

  return (
    <aside aria-label="Aplicación" className="mx-auto w-full max-w-5xl space-y-3 px-5 text-sm sm:px-10">
      {!online && <p role="status" className="rounded-xl border border-border bg-card p-3 text-muted-foreground">Sin conexión. Necesitas internet para consultar precios o guardar cambios.</p>}
      {needRefresh && <div className="flex flex-wrap items-center gap-3 rounded-xl border border-border bg-card p-3">
        <p role="status" className="min-w-0 flex-1 basis-full sm:basis-0">Hay una nueva versión. Guarda tus cambios antes de actualizar.</p>
        <Button onClick={update} disabled={busy || !online}>Actualizar</Button>
        <Button variant="outline" onClick={() => setNeedRefresh(false)} disabled={busy}>Más tarde</Button>
      </div>}
      {!installed && <div>
        <Button variant="outline" onClick={install} disabled={busy} aria-expanded={help} aria-controls="install-help">Instalar app</Button>
        {help && <div id="install-help" className="mt-3 space-y-2 rounded-xl border border-border bg-card p-4 text-muted-foreground">
          <p>Android: abre el menú de Chrome y elige «Instalar aplicación» o «Añadir a pantalla de inicio».</p>
          <p>iPhone: abre esta página en Safari, pulsa Compartir y «Añadir a pantalla de inicio». Activa «Abrir como app» si aparece.</p>
          <p>Después, abre Scrappy desde su icono e introduce tu clave si te la pide.</p>
        </div>}
      </div>}
      {error && <p role="alert" className="text-destructive">{error}</p>}
    </aside>
  );
}
