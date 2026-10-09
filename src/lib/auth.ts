type AuthAction = 'session' | 'login' | 'logout';

export class AuthError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export async function requestAuth(action: AuthAction, key?: string, signal?: AbortSignal): Promise<void> {
  let response: Response;
  try {
    response = await fetch(`/api/${action}`, {
      method: action === 'session' ? 'GET' : 'POST',
      credentials: 'same-origin',
      cache: 'no-store',
      headers: action === 'login' ? { 'Content-Type': 'application/json' } : undefined,
      body: action === 'login' ? JSON.stringify({ key }) : undefined,
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000),
    });
  } catch {
    throw new AuthError(0, 'No pudimos conectar. Comprueba tu conexión e inténtalo de nuevo.');
  }
  if (!response.ok) {
    let message = 'El servicio no está disponible en este momento. Inténtalo de nuevo.';
    if (response.status === 401) message = action === 'login' ? 'Clave incorrecta. Inténtalo de nuevo.' : 'Tu sesión ha caducado.';
    if (response.status === 400) message = 'Revisa la clave: es obligatoria y admite hasta 1024 bytes.';
    if (response.status === 403) message = 'No se pudo validar la solicitud. Recarga la página e inténtalo de nuevo.';
    if (response.status === 429) {
      const seconds = Number(response.headers.get('Retry-After'));
      const minutes = Number.isFinite(seconds) && seconds > 0 ? Math.ceil(seconds / 60) : 15;
      message = `Demasiados intentos. Espera ${minutes} ${minutes === 1 ? 'minuto' : 'minutos'} antes de volver a intentarlo.`;
    }
    throw new AuthError(response.status, message);
  }
  try {
    const payload: unknown = await response.json();
    if (!payload || typeof payload !== 'object' || !('authenticated' in payload)
      || payload.authenticated !== (action !== 'logout')) throw new Error('Invalid response');
  } catch {
    throw new AuthError(0, 'No pudimos confirmar la sesión. Inténtalo de nuevo.');
  }
}
