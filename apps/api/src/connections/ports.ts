import type {
  ConnectionSharingStore,
  ConnectionLookupStore,
  ConnectionManagementStore,
  ConnectionReadStore,
  ConnectionTestStore,
  ConnectionUsageStore,
  OAuth2ConsentStore,
} from '@pertexo/core/connections';
import type { NotificationDestinationStore } from '@pertexo/core/notifications';
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

export type ConnectionCommandPersistence = ConnectionManagementStore;

export type ConnectionReadPersistence = ConnectionReadStore;

export type ConnectionTestPersistence = ConnectionTestStore;

export type ConnectionLookupPersistence = ConnectionLookupStore;

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
  persistence: OAuth2ConsentStore;
  endpointPolicy: OAuth2EndpointPolicy;
  /** Token requests only: it carries the operator's address policy (S17). */
  tokenClient: Pick<SecureHttpClient, 'execute' | 'isAddressBlocked'>;
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
  destinationPersistence?: NotificationDestinationStore;
  usagePersistence?: ConnectionUsageStore;
  sharingPersistence?: ConnectionSharingStore;
  oauth2?: ConnectionOAuth2Dependencies;
}>;
