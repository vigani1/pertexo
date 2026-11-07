import { connectionUsageResponseSchema } from '@pertexo/contracts';
import type { ConnectionUsageStore } from '@pertexo/core/connections';
import { z } from 'zod';

import {
  opaqueCursor,
  decodeOpaqueCursor,
  encodeOpaqueCursor,
} from '../../platform/http/opaque-cursor.js';
import type { WorkspaceAuthorizationSource } from '../../authorization/index.js';
import {
  authorizeWorkspaceOperation,
  BROWSABLE_WORKSPACE_STATUSES,
} from '../../authorization/index.js';
import { authorizeConnectionOperation } from '../authorization.js';
import { InvalidConnectionCursorError } from '../cursor.js';
import type { ConnectionCommandInput } from './connection-serialization.js';
import {
  CONNECTION_OPERATION,
  NOOP_CONNECTION_TELEMETRY,
  type ConnectionTelemetry,
} from '../telemetry.js';

const cursorSchema = opaqueCursor('connection_usage', {
  workspaceId: z.uuid(),
  connectionId: z.uuid(),
  workflowVersionId: z.uuid(),
});

export function encodeConnectionUsageCursor(
  cursor: z.output<typeof cursorSchema>,
): string {
  return encodeOpaqueCursor(cursorSchema, cursor);
}

export function decodeConnectionUsageCursor(
  value: string,
  workspaceId: string,
  connectionId: string,
) {
  const cursor = decodeOpaqueCursor(cursorSchema, value);
  if (
    cursor?.workspaceId !== workspaceId ||
    cursor.connectionId !== connectionId
  )
    throw new InvalidConnectionCursorError();
  return Object.freeze({ workflowVersionId: cursor.workflowVersionId });
}

export class ListConnectionUsageUseCase {
  public constructor(
    private readonly persistence: ConnectionUsageStore,
    private readonly authorization: WorkspaceAuthorizationSource,
    private readonly telemetry: ConnectionTelemetry = NOOP_CONNECTION_TELEMETRY,
  ) {}

  public execute(
    input: ConnectionCommandInput &
      Readonly<{ connectionId: string; limit?: number; after?: string }>,
  ) {
    return this.telemetry.measure(CONNECTION_OPERATION.usage, () =>
      this.read(input),
    );
  }

  private async read(
    input: ConnectionCommandInput &
      Readonly<{ connectionId: string; limit?: number; after?: string }>,
  ) {
    await authorizeConnectionOperation(
      input,
      this.authorization,
      'connection:read',
    );
    // The guard context proves connection-read only, not this second capability.
    await authorizeWorkspaceOperation({
      actor: input.actor,
      routeWorkspaceId: input.routeWorkspaceId,
      capability: 'workflow:read',
      access: this.authorization,
      disclosure: 'not_found',
      allowedWorkspaceStatuses: BROWSABLE_WORKSPACE_STATUSES,
    });
    const page = await this.persistence.listConnectionUsage({
      workspaceId: input.routeWorkspaceId,
      actorId: input.actor.actorId,
      connectionId: input.connectionId,
      ...(input.limit === undefined ? {} : { limit: input.limit }),
      ...(input.after === undefined
        ? {}
        : {
            after: decodeConnectionUsageCursor(
              input.after,
              input.routeWorkspaceId,
              input.connectionId,
            ),
          }),
    });
    return connectionUsageResponseSchema.parse({
      items: page.items,
      nextCursor:
        page.nextCursor === undefined
          ? null
          : encodeConnectionUsageCursor({
              kind: 'connection_usage',
              workspaceId: input.routeWorkspaceId,
              connectionId: input.connectionId,
              workflowVersionId: page.nextCursor.workflowVersionId,
            }),
    });
  }
}
