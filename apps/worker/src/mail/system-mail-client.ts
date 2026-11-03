import {
  createNodeSecureHttpClient,
  createResendSystemMailClient,
  createSmtpClient,
  type SecureHttpClient,
  type SystemMailClient,
  type SystemMailConfig,
} from '@pertexo/integrations/server';

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
