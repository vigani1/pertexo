import {
  CONNECTION_TEST_TIMEOUT_MILLIS,
  type resendApiKeyCredentialSchema,
} from '@pertexo/contracts';
import type { z } from 'zod';
import type { ConnectionEmailClient } from '../ports.js';
import { connectionTestProviderKey } from '../management/connection-serialization.js';
import type { TestConnectionCommand } from './test-connection.js';
import { resendTestOutcome } from './outcomes.js';

export async function testResendConnection(
  client: ConnectionEmailClient,
  credential: z.output<typeof resendApiKeyCredentialSchema>,
  {
    toEmail,
    command,
    signal,
    beforeDispatch,
  }: Readonly<{
    toEmail: string;
    command: TestConnectionCommand;
    signal: AbortSignal;
    beforeDispatch(): Promise<void>;
  }>,
) {
  const result = await client.sendNotification({
    apiKey: credential.apiKey,
    fromEmail: credential.fromEmail,
    toEmail,
    subject: 'Pertexo alert destination test',
    text: 'This is a test of your Pertexo alert destination. No workflow failed.',
    idempotencyKey: connectionTestProviderKey(
      command.connectionId,
      command.idempotencyKey,
    ),
    timeoutMillis: CONNECTION_TEST_TIMEOUT_MILLIS,
    signal,
    beforeDispatch,
  });
  return resendTestOutcome(result);
}
