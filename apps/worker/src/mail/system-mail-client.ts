import {
  createNodeSecureHttpClient,
  createResendSystemMailClient,
  type SecureHttpClient,
} from '@pertexo/integrations/server';
import {
  createSmtpClient,
  type SystemMailClient,
  type SystemMailConfig,
} from '@pertexo/secrets/server';

/** The worker selects the install's transport; provider code only receives its client. */
export function createSystemMailClient(
  config: SystemMailConfig,
  http?: Pick<SecureHttpClient, 'execute'>,
): SystemMailClient {
  return config.mode === 'smtp'
    ? createSmtpClient(config)
    : createResendSystemMailClient(
        config,
        http ?? createNodeSecureHttpClient(),
      );
}
