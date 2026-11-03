import {
  createResendClient,
  type ResendApiResult,
  type ResendClient,
} from './client.js';
import type { SecureHttpClient } from '../http/secure.js';
type ResendMailMessage = Omit<
  Parameters<ResendClient['sendNotification']>[0],
  'apiKey'
>;
type ResendMailFailure = Readonly<{
  category:
    | 'network'
    | 'rate_limited'
    | 'invalid_response'
    | 'provider_unavailable'
    | 'provider_rejected'
    | 'authentication'
    | 'sender_rejected';
  status?: number;
}>;
type ResendMailResult =
  | Readonly<{ kind: 'submitted'; reference: string }>
  | Readonly<{ kind: 'failed' | 'retryable'; failure: ResendMailFailure }>;

export function createResendSystemMailClient(
  config: Readonly<{ apiKey: string }>,
  http: Pick<SecureHttpClient, 'execute'>,
) {
  const resend = createResendClient(http);
  return Object.freeze({
    deduplicates: true,
    sendNotification: async (
      message: ResendMailMessage,
    ): Promise<ResendMailResult> => {
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
        return {
          kind: permanentRejection ? 'failed' : 'retryable',
          failure: resendFailure(result),
        };
      } catch {
        // Resend accepts the same command identity again after an uncertain request.
        return { kind: 'retryable', failure: { category: 'network' } };
      }
    },
  });
}

function resendFailure(
  result: Exclude<ResendApiResult, { kind: 'succeeded' }>,
): ResendMailFailure {
  if (result.kind === 'rate_limited')
    return { category: 'rate_limited', status: 429 };
  if (result.kind === 'invalid_response')
    return { category: 'invalid_response' };
  const { status } = result;
  let category: ResendMailFailure['category'] =
    status >= 500 ? 'provider_unavailable' : 'provider_rejected';
  if (status === 401) category = 'authentication';
  if (result.kind === 'rejected') {
    if (
      ['missing_api_key', 'invalid_api_key', 'restricted_api_key'].includes(
        result.error,
      )
    )
      category = 'authentication';
    else if (result.error === 'domain_not_verified')
      category = 'sender_rejected';
  }
  return { category, ...(status >= 100 && status <= 599 ? { status } : {}) };
}
