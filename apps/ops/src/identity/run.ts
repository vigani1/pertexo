import { randomUUID } from 'node:crypto';
import type { TwoFactorRecoveryStore } from '@pertexo/core/tenant-access';
import {
  authenticationMailAssociatedData,
  type SystemMailInput,
} from '@pertexo/secrets/server';
import { createApplicationSecretEnvelope } from '@pertexo/integrations/server';
import type { TwoFactorRecoveryConfig } from './config.js';

export async function disableTwoFactor(
  config: TwoFactorRecoveryConfig,
  store: TwoFactorRecoveryStore,
) {
  const envelope =
    config.mail.mode === 'durable'
      ? createApplicationSecretEnvelope(config.mail.encryption)
      : undefined;
  const result = await store.disable(
    config.email,
    (user): SystemMailInput | undefined => {
      if (config.mail.mode !== 'durable' || envelope === undefined)
        return undefined;
      const id = randomUUID();
      const expiresAt = new Date(Date.now() + 24 * 60 * 60_000);
      const purpose = 'two_factor_disabled' as const;
      return {
        id,
        purpose,
        expiresAt,
        sealedPayload: envelope.seal(
          JSON.stringify({
            fromEmail: config.mail.fromEmail,
            toEmail: user.email,
            subject: 'An operator turned off two-factor sign-in',
            text: [
              `Hello ${user.displayName},`,
              '',
              'An operator removed the authenticator and recovery codes from your Pertexo account.',
              'Sign in with your password and set up two-factor sign-in again.',
              'If you did not ask for this, contact your Pertexo operator immediately.',
              config.accountUrl,
            ].join('\n'),
          }),
          authenticationMailAssociatedData(purpose, id, expiresAt),
        ),
      };
    },
  );
  return {
    command: 'identity.two-factor.disable',
    ...result,
    actorRef: config.actorRef,
    reason: config.reason,
    ...(result.status === 'disabled'
      ? {
          securityNotice:
            config.mail.mode === 'durable'
              ? 'queued'
              : 'local development only; no email sent',
        }
      : {}),
  };
}
