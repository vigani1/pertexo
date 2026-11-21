import {
  resendApiKeyCredentialSchema,
  slackBotTokenCredentialSchema,
  type FailureNotificationDestinationResponse,
  type ParsedConnectionCredential,
} from '@pertexo/contracts';
import { ConnectionSecretEncryptionError } from '@pertexo/secrets/server';
import type { ConnectionTestOutcome } from '@pertexo/workflow-model';
import { hasCredentialType } from '../credential-type.js';
import type { ConnectionEmailClient, ConnectionSlackClient } from '../ports.js';
import { testResendConnection } from './resend.js';
import { testSlackConnection } from './slack.js';
import type { TestConnectionCommand } from './test-connection.js';

export function testDestination(
  clients: Readonly<{
    email: ConnectionEmailClient | undefined;
    slack: Pick<ConnectionSlackClient, 'authTest' | 'sendMessage'> | undefined;
  }>,
  destination: FailureNotificationDestinationResponse,
  credential: ParsedConnectionCredential,
  {
    command,
    ...dispatch
  }: Readonly<{
    command: TestConnectionCommand;
    signal: AbortSignal;
    beforeDispatch: () => Promise<void>;
  }>,
): Promise<ConnectionTestOutcome> {
  if (destination.config.kind === 'email') {
    if (
      !hasCredentialType(credential, resendApiKeyCredentialSchema) ||
      clients.email === undefined
    )
      throw new ConnectionSecretEncryptionError();
    return testResendConnection(clients.email, credential, {
      toEmail: destination.config.toEmail,
      command,
      ...dispatch,
    });
  }
  if (destination.config.kind === 'slack') {
    if (
      !hasCredentialType(credential, slackBotTokenCredentialSchema) ||
      clients.slack === undefined
    )
      throw new ConnectionSecretEncryptionError();
    return testSlackConnection(clients.slack, credential.botToken, {
      channelId: destination.config.channelId,
      ...dispatch,
    });
  }
  throw new ConnectionSecretEncryptionError();
}
