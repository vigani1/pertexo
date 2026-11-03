import type { SecureHttpClient } from '@pertexo/secrets/server';
import { createNodeProviderHttpClient } from '../providers/http-client.js';
import { createResendSystemMailClient } from '@pertexo/integrations/server';
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
        http ?? createNodeProviderHttpClient(),
      );
}
