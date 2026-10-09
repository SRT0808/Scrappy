export type List = { id: string; name: string; emoji: string | null; position: number; created_at: string };
export type ListAction = 'read' | 'create' | 'rename' | 'reorder' | 'delete';

export class ListsError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

function isList(value: unknown): value is List {
  if (!value || typeof value !== 'object') return false;
  const row = value as List;
  return typeof row.id === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(row.id)
    && typeof row.name === 'string' && !!row.name.trim() && [...row.name.trim()].length <= 100
    && (row.emoji === null || typeof row.emoji === 'string') && Number.isInteger(row.position)
    && typeof row.created_at === 'string';
}

export async function requestLists(action: ListAction, body?: { name: string } | { ids: string[] }, id?: string, signal?: AbortSignal): Promise<List[]> {
  let response: Response;
  try {
    response = await fetch(action === 'reorder' ? '/api/lists/reorder' : id ? `/api/lists/${encodeURIComponent(id)}` : '/api/lists', {
      method: { read: 'GET', create: 'POST', rename: 'PATCH', reorder: 'PUT', delete: 'DELETE' }[action],
      credentials: 'same-origin', cache: 'no-store',
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000),
    });
  } catch {
    throw new ListsError(0, 'No pudimos conectar. Actualiza las listas para comprobar si el cambio se guardó.');
  }
  if (!response.ok) {
    const messages: Record<number, string> = {
      400: 'Revisa el nombre: debe tener de 1 a 100 caracteres.',
      401: 'Tu sesión ha caducado. Introduce tu clave para volver a entrar.',
      403: 'No se pudo validar la solicitud. Recarga la página e inténtalo de nuevo.',
      404: 'La lista ya no existe. Actualiza las listas antes de continuar.',
      409: action === 'delete' ? 'La lista contiene productos. Muévelos o elimínalos primero.' : 'Las listas cambiaron. Actualiza las listas antes de continuar.',
    };
    throw new ListsError(response.status, messages[response.status] ?? 'El servicio no está disponible. Actualiza las listas e inténtalo de nuevo.');
  }
  try {
    const payload = await response.json();
    if (action === 'delete') {
      if (payload?.deleted !== true) throw new Error('Invalid deletion');
      return [];
    }
    const rows: unknown = action === 'read' || action === 'reorder' ? payload?.lists : [payload?.list];
    if (!Array.isArray(rows) || !rows.every(isList) || new Set(rows.map(row => row.id)).size !== rows.length) throw new Error('Invalid lists');
    return rows;
  } catch {
    throw new ListsError(0, 'No pudimos confirmar el resultado. Actualiza las listas antes de continuar.');
  }
}
