import type {
  ConnectionSharing,
  ConnectionSharingRequest,
} from '@pertexo/contracts';
import type { ResourceActor } from '../../tenant-access/resources/contract.js';

export type ConnectionSharingStore = Readonly<{
  readConnectionSharing(
    input: ResourceActor & { connectionId: string },
  ): Promise<ConnectionSharing>;
  replaceConnectionSharing(
    input: ResourceActor & {
      connectionId: string;
      request: ConnectionSharingRequest;
      idempotencyKey: string;
      requestId?: string;
      traceId?: string;
    },
  ): Promise<ConnectionSharing & { replayed: boolean }>;
}>;
