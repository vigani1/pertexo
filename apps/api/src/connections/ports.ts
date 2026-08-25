import type {
  ConnectionDatabase,
  FailureNotificationDestinationDatabase,
} from '@pertexo/database';
import type {
  ConnectionSecretContext,
  SealedConnectionSecret,
  SecureHttpClient,
  SlackClient,
  ResendClient,
} from '@pertexo/integrations/server';

import type { WorkspaceAuthorizationSource } from '../identity-workspace/ports.js';
import type { ConnectionTelemetry } from './telemetry.js';

export type ConnectionCommandPersistence = Pick<
  ConnectionDatabase,
  | 'createConnection'
  | 'findConnectionCreateReplay'
  | 'findConnectionRotateReplay'
  | 'rotateConnectionSecret'
  | 'revokeConnection'
>;

export type ConnectionTestPersistence = Pick<
  ConnectionDatabase,
  | 'startConnectionTest'
  | 'resolveConnectionTestSecret'
  | 'markConnectionTestDispatched'
  | 'completeConnectionTest'
  | 'abandonConnectionTest'
>;

export type ConnectionPersistence = ConnectionCommandPersistence &
  ConnectionTestPersistence;

export interface ConnectionSecretEncryptionPort {
  seal(
    plaintext: Uint8Array,
    context: ConnectionSecretContext,
  ): Promise<SealedConnectionSecret>;
  open(
    sealed: SealedConnectionSecret,
    context: ConnectionSecretContext,
  ): Promise<Uint8Array>;
}

export type ConnectionHttpClient = Pick<SecureHttpClient, 'execute'>;
export type ConnectionSlackClient = Pick<SlackClient, 'authTest'>;
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
}>;
