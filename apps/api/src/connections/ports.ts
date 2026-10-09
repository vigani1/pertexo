import type {
  ConnectionLookupDatabase,
  ConnectionManagementDatabase,
  ConnectionReadDatabase,
  ConnectionTestDatabase,
  ConnectionUsageDatabase,
} from '@pertexo/database/connections';
import type { FailureNotificationDestinationDatabase } from '@pertexo/database/notifications';
import type {
  ConnectionSecretContext,
  SealedConnectionSecret,
  SecureHttpClient,
  SlackClient,
  ResendClient,
} from '@pertexo/integrations/server';

import type { WorkspaceAuthorizationSource } from '../workspaces/ports.js';
import type { ConnectionTelemetry } from './telemetry.js';

export type ConnectionCommandPersistence = ConnectionManagementDatabase;

export type ConnectionReadPersistence = ConnectionReadDatabase;

export type ConnectionTestPersistence = ConnectionTestDatabase;

export type ConnectionLookupPersistence = ConnectionLookupDatabase;

export type ConnectionPersistence = ConnectionCommandPersistence &
  ConnectionReadPersistence &
  ConnectionTestPersistence &
  ConnectionLookupPersistence;

export interface ConnectionSecretEncryptionPort {
  seal(
    plaintext: Uint8Array,
    context: ConnectionSecretContext,
    signal: AbortSignal,
  ): Promise<SealedConnectionSecret>;
  open(
    sealed: SealedConnectionSecret,
    context: ConnectionSecretContext,
    signal: AbortSignal,
  ): Promise<Uint8Array>;
}

export type ConnectionHttpClient = Pick<SecureHttpClient, 'execute'>;
export type ConnectionSlackClient = Pick<
  SlackClient,
  'authTest' | 'lookupChannel'
>;
export type ConnectionEmailClient = Pick<ResendClient, 'sendNotification'>;

export type ConnectionDependencies = Readonly<{
  persistence: ConnectionPersistence;
  authorization: WorkspaceAuthorizationSource;
  encryption: ConnectionSecretEncryptionPort;
  httpClient: ConnectionHttpClient;
  slackClient?: ConnectionSlackClient;
  emailClient?: ConnectionEmailClient;
  telemetry?: ConnectionTelemetry;
  destinationPersistence?: FailureNotificationDestinationDatabase;
  usagePersistence?: ConnectionUsageDatabase;
}>;
