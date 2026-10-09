export const intervals = [3, 6, 12, 24] as const;
export function validInterval(value: unknown): value is number {
  return typeof value === 'number' && intervals.includes(value as typeof intervals[number]);
}
export type Run = { id: string; started_at: string; finished_at: string | null; trigger: 'cron' | 'dispatch' | 'local'; checked: number; ok_count: number; fail_count: number };
export type Notification = { id: string; type: string; channel: 'ntfy' | 'email'; status: 'sent' | 'failed'; sent_at: string; title: string; error: string | null };
export type Settings = { default_interval_hours: number; last_run: Run | null; notifications: Notification[]; has_more: boolean };
export type Delivery = { channel: 'ntfy' | 'email'; status: 'sent' | 'failed'; recorded: boolean };
const date = (value: unknown) => typeof value === 'string' && Number.isFinite(Date.parse(value));
export function isSettings(value: unknown): value is Settings {
  if (!value || typeof value !== 'object') return false;
  const row = value as Settings;
  const run = row.last_run;
  return validInterval(row.default_interval_hours) && typeof row.has_more === 'boolean'
    && (run === null || (!!run && typeof run.id === 'string' && date(run.started_at)
      && (run.finished_at === null || (date(run.finished_at) && Date.parse(run.finished_at) >= Date.parse(run.started_at)))
      && ['cron', 'dispatch', 'local'].includes(run.trigger)
      && [run.checked, run.ok_count, run.fail_count].every(n => Number.isInteger(n) && n >= 0)
      && run.checked === run.ok_count + run.fail_count))
    && Array.isArray(row.notifications) && row.notifications.every(n => n && typeof n.id === 'string'
      && typeof n.type === 'string' && ['ntfy', 'email'].includes(n.channel) && ['sent', 'failed'].includes(n.status)
      && date(n.sent_at) && typeof n.title === 'string' && (n.error === null || typeof n.error === 'string'));
}
