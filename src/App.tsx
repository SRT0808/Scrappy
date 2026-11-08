import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Button } from './components/ui/button';
import { Input } from './components/ui/input';
import { Logo } from './components/ui/logo';
import { Notice } from './components/ui/notice';
import { Skeleton } from './components/ui/skeleton';
import { ArrowRight } from 'lucide-react';
import { AuthError, requestAuth } from './lib/auth';
import { HomeScreen } from './components/HomeScreen';
import { PwaControls } from './components/PwaControls';
import { PwaInstallProvider } from './components/PwaInstallProvider';

type SessionState = 'checking' | 'anonymous' | 'authenticated' | 'unavailable';

export function App() {
  const [session, setSession] = useState<SessionState>('checking');
  const [check, setCheck] = useState(0);
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const input = useRef<HTMLInputElement>(null);
  const submitting = useRef(false);

  useEffect(() => {
    const controller = new AbortController();
    setSession('checking');
    setError('');
    requestAuth('session', undefined, controller.signal).then(() => {
      if (!controller.signal.aborted) setSession('authenticated');
    }).catch((failure: AuthError) => {
      if (controller.signal.aborted) return;
      setSession(failure.status === 401 ? 'anonymous' : 'unavailable');
      if (failure.status !== 401) setError(failure.message);
    });
    return () => controller.abort();
  }, [check]);

  useEffect(() => {
    if (session !== 'authenticated') document.title = 'Scrappy · Acceso';
    if (session === 'anonymous' && !busy) input.current?.focus();
  }, [session, busy]);

  async function login(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting.current) return;
    if (!key || new TextEncoder().encode(key).length > 1024) {
      setError('Introduce tu clave de acceso (máximo 1024 bytes).');
      input.current?.focus();
      return;
    }
    submitting.current = true;
    setBusy(true);
    setError('');
    try {
      await requestAuth('login', key);
      // Confirm the browser accepted the cookie before exposing the workspace.
      await requestAuth('session');
      setSession('authenticated');
    } catch (failure) {
      setError((failure as AuthError).message);
    } finally {
      setKey('');
      submitting.current = false;
      setBusy(false);
    }
  }

  async function logout() {
    if (submitting.current) return;
    submitting.current = true;
    setBusy(true);
    setError('');
    try {
      await requestAuth('logout');
      setSession('anonymous');
    } catch (failure) {
      if ((failure as AuthError).status === 401) setSession('anonymous');
      else setError((failure as AuthError).message);
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  }

  return (
    <PwaInstallProvider><div className="flex min-h-dvh flex-col">
      {session !== 'authenticated' && <header className="w-full px-4 sm:px-6">
        <div className="mx-auto flex w-full max-w-6xl items-center py-4 sm:py-6">
          <Logo />
        </div>
      </header>}
      <PwaControls />
      {session === 'authenticated' ? <HomeScreen sessionBusy={busy} sessionError={error} onLogout={logout} onExpired={message => { setKey(''); setSession('anonymous'); setError(message); }} /> : <main className="flex flex-1 items-center justify-center px-4 py-10"><div className="w-full max-w-sm">
          <p className="mb-4 font-mono text-xs text-subtle-foreground">Tu radar de precios</p>
          <section aria-labelledby="access-title" aria-busy={busy || session === 'checking'} className="rounded-xl border border-border bg-card p-6 sm:p-8">
            <div aria-hidden="true" className="mb-6 flex size-11 items-center justify-center rounded-lg border border-border-strong bg-elevated text-foreground">
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><rect x="5" y="10" width="14" height="11" rx="2" /><path d="M8 10V7a4 4 0 0 1 8 0v3M12 15v2" /></svg>
            </div>
            <h1 id="access-title" className="text-[28px] leading-tight font-semibold tracking-tight">Tu próxima oferta empieza aquí.</h1>
            {session === 'checking' ? (
              <div role="status" className="mt-6 space-y-4">
                <p className="text-sm text-muted-foreground">Comprobando tu sesión…</p>
                <Skeleton className="h-11" />
                <Skeleton className="h-11" />
              </div>
            ) : session === 'anonymous' ? (
              <>
                <p className="mt-3 text-sm leading-relaxed text-muted-foreground">Introduce tu clave para entrar a tu espacio personal.</p>
                <form className="mt-7 space-y-5" onSubmit={login}>
                  <div className="space-y-2">
                    <label htmlFor="access-key" className="text-sm font-medium">Clave de acceso</label>
                    <Input ref={input} id="access-key" name="key" type="password" autoComplete="current-password" required disabled={busy} value={key} onChange={event => { setKey(event.target.value); setError(''); }} aria-invalid={!!error} aria-describedby={error ? 'auth-error' : undefined} placeholder="Introduce tu clave" />
                  </div>
                  {error && <Notice id="auth-error" role="alert">{error}</Notice>}
                  <Button type="submit" disabled={busy} className="w-full">{busy ? 'Entrando…' : 'Entrar'}{!busy && <ArrowRight aria-hidden="true" />}</Button>
                  {busy && <p role="status" className="sr-only">Validando tu clave y sesión.</p>}
                </form>
              </>
            ) : (
              <>
                <Notice role="alert" className="mt-5">{error}</Notice>
                <Button className="mt-7 w-full" onClick={() => setCheck(value => value + 1)}>Reintentar conexión</Button>
              </>
            )}
          </section>
          <p className="mt-5 text-center text-xs leading-relaxed text-muted-foreground">Sigue el precio. Elige tu momento.</p>
        </div></main>}
      {session !== 'authenticated' && <footer className="px-6 py-6 text-center text-xs text-muted-foreground">Un espacio privado, solo para ti.</footer>}
    </div></PwaInstallProvider>
  );
}
