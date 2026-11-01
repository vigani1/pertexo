import { connectionSharingRequestSchema } from '@pertexo/contracts';
import type { ConnectionSharingDatabase } from '@pertexo/core/connections';
import type { WorkspaceAuthorizationSource } from '../../workspaces/ports.js';
import { authorizeConnectionOperation } from '../authorization.js';
import type { ConnectionCommandInput } from '../use-cases/support.js';
import {
  CONNECTION_OPERATION,
  NOOP_CONNECTION_TELEMETRY,
  type ConnectionTelemetry,
} from '../telemetry.js';

type SharingInput = ConnectionCommandInput & Readonly<{ connectionId: string }>;
export class ConnectionSharingUseCases {
  constructor(
    private readonly persistence: ConnectionSharingDatabase,
    private readonly authorization: WorkspaceAuthorizationSource,
    private readonly telemetry: ConnectionTelemetry = NOOP_CONNECTION_TELEMETRY,
  ) {}
  read(input: SharingInput) {
    return this.telemetry.measure(
      CONNECTION_OPERATION.sharingRead,
      async () => {
        await authorizeConnectionOperation(input, this.authorization);
        return this.persistence.readConnectionSharing({
          workspaceId: input.routeWorkspaceId,
          actorId: input.actor.actorId,
          connectionId: input.connectionId,
        });
      },
    );
  }
  replace(
    input: SharingInput &
      Readonly<{ request: unknown; idempotencyKey: string }>,
  ) {
    return this.telemetry.measure(
      CONNECTION_OPERATION.sharingUpdate,
      async () => {
        await authorizeConnectionOperation(input, this.authorization);
        const request = connectionSharingRequestSchema.parse(input.request);
        return this.persistence.replaceConnectionSharing({
          workspaceId: input.routeWorkspaceId,
          actorId: input.actor.actorId,
          connectionId: input.connectionId,
          request,
          idempotencyKey: input.idempotencyKey,
          ...(input.requestId === undefined
            ? {}
            : { requestId: input.requestId }),
          ...(input.traceId === undefined ? {} : { traceId: input.traceId }),
        });
      },
    );
  }
}
