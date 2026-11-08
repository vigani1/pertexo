import { requestInputError } from '../../../platform/http/request-input.js';
import type { FailureNotificationDestinationResponse } from '@pertexo/contracts';
import type { TestConnectionCommand } from '../test-connection.js';
import { connectionTestProviderKey } from '../connection-serialization.js';
import { createSmtpClient } from '@pertexo/secrets/server';
import type { smtpCredentialSchema } from '@pertexo/contracts';
import type { ConnectionTestOutcome } from '@pertexo/core/connections';
import type { z } from 'zod';

export type SmtpTestPolicy = NonNullable<
  Parameters<typeof createSmtpClient>[1]
>;

export async function testSmtpConnection(
  credential: z.output<typeof smtpCredentialSchema>,
  policy: SmtpTestPolicy | undefined,
  input: Readonly<{
    timeoutMillis: number;
    signal: AbortSignal;
    beforeDispatch(): Promise<void>;
    command: TestConnectionCommand;
    destination: FailureNotificationDestinationResponse | undefined;
  }>,
): Promise<ConnectionTestOutcome> {
  const toEmail =
    input.destination?.config.kind === 'email'
      ? input.destination.config.toEmail
      : undefined;
  const client = createSmtpClient(
    {
      mode: 'smtp',
      host: credential.host,
      port: credential.port,
      tls: credential.security,
      auth: { user: credential.username, pass: credential.password },
    },
    policy ?? { allowedPrivateNetworks: [], allowPlaintext: false },
  );
  if (toEmail === undefined) await input.beforeDispatch();
  const result =
    toEmail === undefined
      ? await client.verify(input)
      : await client.sendNotification({
          fromEmail: credential.fromEmail,
          ...(credential.fromName === undefined
            ? {}
            : { fromName: credential.fromName }),
          toEmail: toEmail,
          subject: 'Pertexo alert destination test',
          text: 'This is a test of your Pertexo alert destination. No workflow failed.',
          idempotencyKey: connectionTestProviderKey(
            input.command.connectionId,
            input.command.idempotencyKey,
          ),
          timeoutMillis: input.timeoutMillis,
          signal: input.signal,
          beforeDispatch: input.beforeDispatch,
        });
  return result.kind === 'submitted'
    ? { ok: true, httpStatus: 200 }
    : {
        ok: false,
        httpStatus: null,
        errorCode: `connection.smtp_${result.failure.category}`,
        reauthorizationRequired: result.failure.category === 'authentication',
      };
}

export function assertEmailTestProfile(
  credentialType: string,
  request: TestConnectionCommand['request'],
  destination: FailureNotificationDestinationResponse | undefined,
): void {
  if (
    credentialType === 'smtp' &&
    destination === undefined &&
    !('transport' in request)
  )
    throw requestInputError(
      ['transport'],
      'Use the SMTP connection test. No email was sent.',
    );
  if (
    credentialType === 'resend_api_key' &&
    !('sideEffectDisclosureAccepted' in request)
  )
    throw requestInputError(
      ['transport'],
      'This connection uses Resend. Accept its test email before testing.',
    );
}
