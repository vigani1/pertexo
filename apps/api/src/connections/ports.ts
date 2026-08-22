import type { ConnectionDatabase } from '@pertexo/database';
import type {
  ConnectionSecretContext,
  SealedConnectionSecret,
} from '@pertexo/integrations/server';

import type { WorkspaceAuthorizationSource } from '../identity-workspace/ports.js';
import type { ConnectionTelemetry } from './telemetry.js';

export type ConnectionPersistence = Pick<
  ConnectionDatabase,
  | 'createConnection'
  | 'findConnectionCreateReplay'
  | 'findConnectionRotateReplay'
  | 'rotateConnectionSecret'
  | 'revokeConnection'
>;

export interface ConnectionSecretEncryptionPort {
  seal(
    plaintext: Uint8Array,
    context: ConnectionSecretContext,
  ): Promise<SealedConnectionSecret>;
}

export type ConnectionDependencies = Readonly<{
  persistence: ConnectionPersistence;
  authorization: WorkspaceAuthorizationSource;
  encryption: ConnectionSecretEncryptionPort;
  telemetry?: ConnectionTelemetry;
}>;
