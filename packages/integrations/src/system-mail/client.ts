import { createResendClient } from '../email/client.js';
import { createNodeSecureHttpClient } from '../http/transport/node.js';
import type { SecureHttpClient } from '../http/secure.js';
import type { SystemMailClient, SystemMailConfig } from './contracts.js';
import { createSmtpClient } from './smtp.js';

export function createSystemMailClient(
  config: SystemMailConfig,
  http?: Pick<SecureHttpClient, 'execute'>,
): SystemMailClient {
  if (config.mode === 'smtp') return createSmtpClient(config);
  const resend = createResendClient(http ?? createNodeSecureHttpClient());
  return Object.freeze({
    deduplicates: true,
    sendNotification: async (message) => {
      try {
        const result = await resend.sendNotification({
          ...message,
          apiKey: config.apiKey,
        });
        if (result.kind === 'succeeded')
          return { kind: 'submitted', reference: result.emailId };
        const permanentRejection =
          result.kind === 'rejected' &&
          result.status >= 400 &&
          result.status < 500 &&
          ![408, 409, 425, 429].includes(result.status) &&
          result.error !== 'concurrent_idempotent_requests';
        if (permanentRejection) return { kind: 'failed' };
        return { kind: 'retryable' };
      } catch {
        // Resend accepts the same command identity again after an uncertain request.
        return { kind: 'retryable' };
      }
    },
  });
}
