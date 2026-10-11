import { useEffect, useState } from 'react';
import { useRegisterSW } from 'virtual:pwa-register/react';
import { Button } from './ui/button';

export function PwaControls() {
  const [online, setOnline] = useState(navigator.onLine);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const { needRefresh: [needRefresh, setNeedRefresh], updateServiceWorker } = useRegisterSW({
    onRegisterError() { setError('No pudimos comprobar si hay una nueva versión. Comprueba tu conexión y vuelve a abrir la app.'); },
  });

  useEffect(() => {
    const connection = () => setOnline(navigator.onLine);
    window.addEventListener('online', connection);
    window.addEventListener('offline', connection);
    return () => {
      window.removeEventListener('online', connection);
      window.removeEventListener('offline', connection);
    };
  }, []);

  async function update() {
    setBusy(true); setError('');
    try { await updateServiceWorker(true); }
    catch { setError('No pudimos actualizar. Comprueba tu conexión y vuelve a intentarlo.'); }
    finally { setBusy(false); }
  }

  if (online && !needRefresh && !error) return null;

  return (
    <aside aria-label="Aplicación" className="w-full px-5 text-sm">
      <div className="mx-auto w-full max-w-6xl space-y-3">
        {!online && <p role="status" className="rounded-xl border border-border bg-card p-3 text-muted-foreground">Sin conexión. Necesitas internet para consultar precios o guardar cambios.</p>}
        {needRefresh && <div className="flex flex-wrap items-center gap-3 rounded-xl border border-border bg-card p-3">
          <p role="status" className="min-w-0 flex-1 basis-full sm:basis-0">Hay una nueva versión. Guarda tus cambios antes de actualizar.</p>
          <Button onClick={update} disabled={busy || !online}>Actualizar</Button>
          <Button variant="outline" onClick={() => setNeedRefresh(false)} disabled={busy}>Más tarde</Button>
        </div>}
        {error && <p role="alert" className="text-destructive">{error}</p>}
      </div>
    </aside>
  );
}
