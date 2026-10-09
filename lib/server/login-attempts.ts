export async function recordLoginAttempt(ip: string, success: boolean): Promise<number> {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key || new URL(url).protocol !== 'https:') {
    throw new Error('Missing database configuration');
  }
  const response = await fetch(new URL('/rest/v1/rpc/record_login_attempt', url), {
    method: 'POST',
    headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ p_ip: ip, p_success: success }),
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) throw new Error('Login attempt storage unavailable');
  const retryAfter: unknown = await response.json();
  if (!Number.isInteger(retryAfter) || Number(retryAfter) < 0 || Number(retryAfter) > 900) {
    throw new Error('Invalid login attempt response');
  }
  return Number(retryAfter);
}
