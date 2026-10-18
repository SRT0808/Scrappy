import nodemailer from 'nodemailer';
import type { PurchaseWorkerSenders, PendingPurchaseEvent } from './purchase-worker.js';

type Notice = Parameters<PurchaseWorkerSenders['ntfy']>[0];
export function renderPurchaseNotice(origin: string, notice: Notice, event: PendingPurchaseEvent) {
  const base = new URL(origin);
  if (base.protocol !== 'https:' || base.username || base.password || base.pathname !== '/' || base.search || base.hash)
    throw new Error('invalid_purchase_app_origin');
  if (notice.basketPath !== `/?basket=${event.listId}` || !/^[1-9]\d*$/.test(event.configurationVersion) ||
      !Number.isFinite(Date.parse(event.evaluatedAt))) throw new Error('invalid_purchase_notice_context');
  const link = new URL(notice.basketPath, base).href;
  const text = `Evaluación histórica de alternativas.\n${notice.message}\nEvento: ${event.eventId}\nVersión de configuración: ${event.configurationVersion}\nFecha de evaluación: ${event.evaluatedAt}\nConsulta el estado actual de la canasta: ${link}`;
  return { title: notice.title, text, link };
}

export interface PurchaseTransportOptions {
  appOrigin: string;
  ntfyTopic: string;
  gmailUser: string;
  gmailPassword: string;
  emailTo: string;
}
export interface PurchaseProviders {
  fetch: typeof globalThis.fetch;
  smtp: (timeoutMs: number) => {
    sendMail(message: { from: string; to: string; subject: string; text: string }): Promise<{ accepted: unknown[]; rejected: unknown[] }>;
    close(): void;
  };
}
// Explicit dependencies allow provider fixtures without environment reads or
// network at import/construction. No legacy notifications are written here.
export function purchaseTransports(options: PurchaseTransportOptions, providers: PurchaseProviders = {
  fetch: globalThis.fetch,
  smtp: (timeoutMs: number) => nodemailer.createTransport({ host: 'smtp.gmail.com', port: 465, secure: true,
    auth: { user: options.gmailUser, pass: options.gmailPassword }, tls: { rejectUnauthorized: true },
    connectionTimeout: timeoutMs, greetingTimeout: timeoutMs, socketTimeout: timeoutMs,
    disableFileAccess: true, disableUrlAccess: true }),
}): PurchaseWorkerSenders {
  // Validate eagerly, before any channel can be claimed.
  const base = new URL(options.appOrigin);
  if (base.protocol !== 'https:' || base.username || base.password || base.pathname !== '/' || base.search || base.hash ||
      !/^[A-Za-z0-9_-]{24,}$/.test(options.ntfyTopic) ||
      !/^[^\s@<>;,]+@[^\s@<>;,]+$/.test(options.gmailUser) ||
      !/^[^\s@<>;,]+@[^\s@<>;,]+$/.test(options.emailTo) || !options.gmailPassword)
    throw new Error('invalid_purchase_transport_config');
  return {
    async ntfy(notice, context) {
      if (context.signal.aborted) return 'ambiguous';
      const message = renderPurchaseNotice(options.appOrigin, notice, context);
      try {
        const response = await providers.fetch('https://ntfy.sh/', { method: 'POST', redirect: 'error',
          headers: { 'Content-Type': 'application/json' }, signal: context.signal,
          body: JSON.stringify({ topic: options.ntfyTopic, title: message.title, message: message.text, click: message.link }) });
        if (!response.ok) return response.status >= 400 && response.status < 500 && response.status !== 408 ? 'failed' : 'ambiguous';
        const receipt = await response.json();
        if (context.signal.aborted) return 'ambiguous';
        return receipt.event === 'message' && typeof receipt.id === 'string' && receipt.id.length > 0 ? 'sent' : 'ambiguous';
      } catch { return 'ambiguous'; }
    },
    async email(notice, context) {
      if (context.signal.aborted) return 'ambiguous';
      const message = renderPurchaseNotice(options.appOrigin, notice, context);
      const transport = providers.smtp(context.timeoutMs);
      const abort = () => transport.close();
      context.signal.addEventListener('abort', abort, { once: true });
      try {
        const receipt = await transport.sendMail({ from: options.gmailUser, to: options.emailTo, subject: message.title, text: message.text });
        if (context.signal.aborted) return 'ambiguous';
        if (receipt.accepted.length === 1 && receipt.rejected.length === 0 &&
            String(receipt.accepted[0]).toLowerCase() === options.emailTo.toLowerCase()) return 'sent';
        return receipt.accepted.length === 0 && receipt.rejected.length > 0 ? 'failed' : 'ambiguous';
      } catch (error) {
        const code = (error as { responseCode?: number }).responseCode;
        return !context.signal.aborted && code && code >= 400 && code <= 599 ? 'failed' : 'ambiguous';
      } finally { context.signal.removeEventListener('abort', abort); transport.close(); }
    },
  };
}
