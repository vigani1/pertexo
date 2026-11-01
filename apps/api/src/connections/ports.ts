import type {
  ConnectionSharingDatabase,
  ConnectionLookupDatabase,
  ConnectionManagementDatabase,
  ConnectionReadDatabase,
  ConnectionTestDatabase,
  ConnectionUsageDatabase,
  OAuth2ConsentDatabase,
} from '@pertexo/core/connections';
import type { FailureNotificationDestinationDatabase } from '@pertexo/core/notifications';
import type {
  ConnectionSecretContext,
  OAuth2EndpointPolicy,
  OAuth2TokenService,
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
> &
  Partial<Pick<SlackClient, 'sendMessage'>>;
export type ConnectionEmailClient = Pick<ResendClient, 'sendNotification'>;

/** What OAuth2 connections add; an install has them or the routes don't exist. */
export type ConnectionOAuth2Dependencies = Readonly<{
  persistence: OAuth2ConsentDatabase;
  endpointPolicy: OAuth2EndpointPolicy;
  /** Token requests only: it carries the operator's address policy (S17). */
  tokenClient: Pick<SecureHttpClient, 'execute'>;
  /** A connection test's own request, under the public-only rule. */
  apiClient: Pick<SecureHttpClient, 'executeStreaming'>;
  tokens: Pick<OAuth2TokenService, 'accessToken' | 'rejectToken'>;
}>;

export type ConnectionDependencies = Readonly<{
  applicationSecret: string;
  persistence: ConnectionPersistence;
  authorization: WorkspaceAuthorizationSource;
  encryption: ConnectionSecretEncryptionPort;
  httpClient: ConnectionHttpClient;
  slackClient?: ConnectionSlackClient;
  emailClient?: ConnectionEmailClient;
  telemetry?: ConnectionTelemetry;
  destinationPersistence?: FailureNotificationDestinationDatabase;
  usagePersistence?: ConnectionUsageDatabase;
  sharingPersistence?: ConnectionSharingDatabase;
  oauth2?: ConnectionOAuth2Dependencies;
}>;
