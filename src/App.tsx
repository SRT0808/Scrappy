import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Button } from './components/ui/button';
import { Input } from './components/ui/input';
import { AuthError, requestAuth } from './lib/auth';
import { ListsScreen } from './components/ListsScreen';

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
    document.title = session === 'authenticated' ? 'Scrappy · Listas' : 'Scrappy · Acceso';
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
    <div className="flex min-h-dvh flex-col">
      <header className="flex items-center gap-3 px-6 py-6 sm:px-10">
        <span aria-hidden="true" className="flex size-9 items-center justify-center rounded-xl bg-primary text-primary-foreground">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m4 9 6 6L20 5M13 5h7v7" /></svg>
        </span>
        <span className="text-lg font-semibold tracking-tight">scrappy<span className="text-primary">.</span></span>
      </header>
      <main className="flex flex-1 items-center justify-center px-5 py-10">
        {session === 'authenticated' ? <ListsScreen sessionBusy={busy} sessionError={error} onLogout={logout} onExpired={message => { setKey(''); setSession('anonymous'); setError(message); }} /> : <div className="w-full max-w-sm">
          <p className="mb-5 text-xs font-medium tracking-[0.16em] text-primary uppercase">Tu radar de precios</p>
          <section aria-labelledby="access-title" aria-busy={busy || session === 'checking'} className="rounded-2xl border border-border bg-card p-6 shadow-xl shadow-black/20 sm:p-8">
            <div aria-hidden="true" className="mb-6 flex size-11 items-center justify-center rounded-xl border border-border bg-muted text-primary">
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><rect x="5" y="10" width="14" height="11" rx="2" /><path d="M8 10V7a4 4 0 0 1 8 0v3M12 15v2" /></svg>
            </div>
            <h1 id="access-title" className="text-2xl font-semibold tracking-tight">Tu próxima oferta empieza aquí.</h1>
            {session === 'checking' ? (
              <div role="status" className="mt-6 space-y-4">
                <p className="text-sm text-muted-foreground">Comprobando tu sesión…</p>
                <div aria-hidden="true" className="h-12 rounded-lg bg-muted" />
                <div aria-hidden="true" className="h-11 rounded-lg bg-muted" />
              </div>
            ) : session === 'anonymous' ? (
              <>
                <p className="mt-3 text-sm leading-relaxed text-muted-foreground">Introduce tu clave para entrar a tu espacio personal.</p>
                <form className="mt-7 space-y-5" onSubmit={login}>
                  <div className="space-y-2">
                    <label htmlFor="access-key" className="text-sm font-medium">Clave de acceso</label>
                    <Input ref={input} id="access-key" name="key" type="password" autoComplete="current-password" required disabled={busy} value={key} onChange={event => { setKey(event.target.value); setError(''); }} aria-invalid={!!error} aria-describedby={error ? 'auth-error' : undefined} placeholder="Introduce tu clave" />
                  </div>
                  {error && <p id="auth-error" role="alert" className="text-sm leading-relaxed text-destructive">{error}</p>}
                  <Button type="submit" disabled={busy} className="w-full">{busy ? 'Entrando…' : 'Entrar'}{!busy && <span aria-hidden="true">→</span>}</Button>
                  {busy && <p role="status" className="sr-only">Validando tu clave y sesión.</p>}
                </form>
              </>
            ) : (
              <>
                <p role="alert" className="mt-4 text-sm leading-relaxed text-destructive">{error}</p>
                <Button className="mt-7 w-full" onClick={() => setCheck(value => value + 1)}>Reintentar conexión</Button>
              </>
            )}
          </section>
          <p className="mt-5 text-center text-xs leading-relaxed text-muted-foreground">Sigue el precio. Elige tu momento.</p>
        </div>}
      </main>
      <footer className="px-6 py-6 text-center text-xs text-muted-foreground">Un espacio privado, solo para ti.</footer>
    </div>
  );
}
