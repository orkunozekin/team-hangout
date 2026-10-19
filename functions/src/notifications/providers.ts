import { Data } from '../commandSupport';
import { DeliveryFailure, developmentTransport, essentialEmailApiKey, productionTransport, senderConfig } from '../email/transport';
import { getAuth } from 'firebase-admin/auth';

export type ProviderResult = { outcome: 'accepted' | 'retryable' | 'permanent'; messageId?: string; retryAfterMs?: number };
export type DeliveryProvider = { send(delivery: Data): Promise<ProviderResult> };
export type ReceiptResult = { outcome: 'ok' | 'retryable' | 'permanent'; errorCode?: string };
export type ReceiptProvider = { get(receiptId: string): Promise<ReceiptResult> };

function retryAfter(response: Response): number | undefined {
  const raw = response.headers.get('retry-after');
  if (!raw) return undefined;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, 3_600_000);
  const date = Date.parse(raw);
  return Number.isFinite(date) ? Math.min(Math.max(0, date - Date.now()), 3_600_000) : undefined;
}

function expoHeaders() {
  const token = process.env.EXPO_PUSH_ACCESS_TOKEN;
  return { Accept: 'application/json', 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) };
}

export function expoPushProvider(fetcher: typeof fetch = fetch): DeliveryProvider {
  return { async send(delivery) {
    if (process.env.PUSH_DELIVERY_ENABLED !== 'true' || typeof delivery.endpointToken !== 'string') return { outcome: 'permanent' };
    let response: Response;
    try {
      response = await fetcher('https://exp.host/--/api/v2/push/send', { method: 'POST', signal: AbortSignal.timeout(15_000), headers: expoHeaders(),
        body: JSON.stringify({ to: delivery.endpointToken, title: delivery.title, body: delivery.body, channelId: 'team-updates',
          data: { url: `teamhangout://notification?id=${encodeURIComponent(delivery.notificationId)}&revision=${delivery.sourceRevision}` } }) });
    } catch { throw new Error('AMBIGUOUS_PUSH_RESULT'); }
    if (response.status === 429) return { outcome: 'retryable', retryAfterMs: retryAfter(response) };
    if (!response.ok) {
      if (response.status >= 500) throw new Error('AMBIGUOUS_PUSH_RESULT');
      return { outcome: 'permanent' };
    }
    let body: Data;
    try { body = await response.json() as Data; } catch { throw new Error('AMBIGUOUS_PUSH_RESULT'); }
    const ticket = Array.isArray(body.data) ? body.data[0] : body.data;
    if (ticket?.status === 'ok' && typeof ticket.id === 'string') return { outcome: 'accepted', messageId: ticket.id };
    const code = ticket?.details?.error;
    return { outcome: code === 'DeviceNotRegistered' || code === 'InvalidCredentials' ? 'permanent' : 'retryable' };
  } };
}

export function expoReceiptProvider(fetcher: typeof fetch = fetch): ReceiptProvider {
  return { async get(receiptId) {
    if (process.env.PUSH_DELIVERY_ENABLED !== 'true') return { outcome: 'retryable', errorCode: 'PROVIDER_DISABLED' };
    let response: Response;
    try { response = await fetcher('https://exp.host/--/api/v2/push/getReceipts', { method: 'POST', signal: AbortSignal.timeout(15_000),
      headers: expoHeaders(), body: JSON.stringify({ ids: [receiptId] }) }); } catch { return { outcome: 'retryable', errorCode: 'RECEIPT_UNAVAILABLE' }; }
    if (!response.ok) return { outcome: 'retryable', errorCode: `RECEIPT_HTTP_${response.status}` };
    try {
      const body = await response.json() as Data, receipt = body.data?.[receiptId];
      if (!receipt) return { outcome: 'retryable', errorCode: 'RECEIPT_PENDING' };
      if (receipt.status === 'ok') return { outcome: 'ok' };
      const code = typeof receipt.details?.error === 'string' ? receipt.details.error : 'PUSH_REJECTED';
      return { outcome: code === 'DeviceNotRegistered' || code === 'InvalidCredentials' ? 'permanent' : 'retryable', errorCode: code };
    } catch { return { outcome: 'retryable', errorCode: 'RECEIPT_INVALID' }; }
  } };
}

export function notificationEmailProvider(): DeliveryProvider | null {
  const config = senderConfig();
  if (!config || process.env.NOTIFICATION_EMAIL_ENABLED !== 'true') return null;
  const transport = process.env.FUNCTIONS_EMULATOR === 'true' ? developmentTransport()
    : productionTransport(config, essentialEmailApiKey.value());
  return { async send(delivery) {
    try {
      const user = await getAuth().getUser(delivery.recipientUid);
      if (user.disabled || !user.emailVerified || user.email?.toLowerCase() !== delivery.recipientEmail) return { outcome: 'permanent' };
      const messageId = await transport.send(`notification-${delivery.id}`, { to: delivery.recipientEmail,
        subject: delivery.title, text: `${delivery.body}\n\nOpen this update after signing in: teamhangout://notification?id=${delivery.notificationId}&revision=${delivery.sourceRevision}\nReply to: ${config.replyTo}\nPrivacy: ${config.privacyPolicyUrl}` });
      return { outcome: 'accepted', messageId };
    } catch (error) {
      if (error instanceof DeliveryFailure && error.code === 'PRE_SEND') return { outcome: 'retryable' };
      if (error instanceof DeliveryFailure && ['BOUNCE', 'REJECTED'].includes(error.code)) return { outcome: 'permanent' };
      throw error;
    }
  } };
}
