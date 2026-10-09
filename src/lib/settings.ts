import { isSettings, validInterval, type Settings, type Delivery } from '../../lib/settings-contract';
export type { Settings, Delivery } from '../../lib/settings-contract';
export class SettingsError extends Error {
  constructor(public status: number, message: string) { super(message); }
}
export async function requestSettings(method = 'GET', body?: unknown, query = '', signal?: AbortSignal) {
  let response: Response;
  try {
    response = await fetch(`/api/settings${query}`, { method, credentials: 'same-origin', cache: 'no-store',
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(60000)]) : AbortSignal.timeout(60000) });
  } catch { throw new SettingsError(0, 'Se perdió la conexión. Actualiza el historial antes de repetir un envío.'); }
  if (!response.ok) throw new SettingsError(response.status, response.status === 401
    ? 'Tu sesión ha caducado. Introduce tu clave para volver a entrar.' : 'No pudimos completar la solicitud. Inténtalo de nuevo.');
  try { return await response.json(); }
  catch { throw new SettingsError(0, 'No pudimos confirmar el resultado. Actualiza los ajustes.'); }
}
export async function loadSettings(page: number, signal?: AbortSignal): Promise<Settings> {
  const value: unknown = await requestSettings('GET', undefined, `?page=${page}`, signal);
  if (!isSettings(value)) throw new SettingsError(0, 'La respuesta de ajustes no es válida.');
  return value;
}
export async function loadDefaultInterval(signal?: AbortSignal): Promise<number> {
  const value = await requestSettings('GET', undefined, '?view=defaults', signal);
  if (!validInterval(value?.default_interval_hours)) throw new SettingsError(0, 'No pudimos cargar el intervalo por defecto.');
  return value.default_interval_hours;
}
export async function saveInterval(interval: number) {
  const value = await requestSettings('PATCH', { default_interval_hours: interval });
  if (value?.default_interval_hours !== interval) throw new SettingsError(0, 'No pudimos confirmar el intervalo guardado.');
}
export async function sendTest(): Promise<Delivery[]> {
  const value = await requestSettings('POST', { action: 'test' });
  if (!Array.isArray(value?.deliveries) || value.deliveries.length !== 2
    || !['ntfy', 'email'].every(channel => value.deliveries.filter((d: Delivery) => d?.channel === channel).length === 1)
    || !value.deliveries.every((d: Delivery) => ['sent', 'failed'].includes(d.status) && typeof d.recorded === 'boolean'))
    throw new SettingsError(0, 'No pudimos confirmar los envíos. Actualiza el historial antes de repetir.');
  return value.deliveries;
}
