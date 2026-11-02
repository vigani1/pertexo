import type { ConnectionSharingRequest } from '@pertexo/contracts';
import type { ResourceActor } from '../../shared/contract.js';

export type ReadConnectionSharingInput = ResourceActor &
  Readonly<{ connectionId: string }>;

export type ReplaceConnectionSharingInput = ReadConnectionSharingInput &
  Readonly<{
    request: ConnectionSharingRequest;
    idempotencyKey: string;
    requestId?: string;
    traceId?: string;
  }>;
