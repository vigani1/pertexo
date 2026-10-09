import { Controller, Get, Param, Query, Req, UseGuards } from '@nestjs/common';
import {
  connectionListQuerySchema,
  connectionIdParamSchema,
  connectionUsageResponseSchema,
} from '@pertexo/contracts';
import type { ConnectionUsageDatabase } from '@pertexo/database/connections';
import { z } from 'zod';

import { SessionAuthenticationGuard } from '../../workspaces/index.js';
import { projectAuthenticatedWorkspaceContext } from '../../workspaces/request/authenticated-context.js';
import { RateLimit } from '../../platform/rate-limit/metadata.js';
import type { WorkspaceAuthorizationSource } from '../../authorization/index.js';
import { authorizeWorkspaceOperation } from '../../authorization/index.js';
import { authorizeConnectionOperation } from '../authorization.js';
import { InvalidConnectionCursorError } from '../cursor.js';
import { ConnectionReadGuard } from '../http/guards.js';
import type { ConnectionRequest } from '../types.js';
import type { ConnectionCommandInput } from './support.js';
import {
  CONNECTION_OPERATION,
  NOOP_CONNECTION_TELEMETRY,
  type ConnectionTelemetry,
} from '../telemetry.js';

const cursorSchema = z
  .object({
    kind: z.literal('connection_usage'),
    workspaceId: z.uuid(),
    connectionId: z.uuid(),
    workflowVersionId: z.uuid(),
  })
  .strict();

export function encodeConnectionUsageCursor(
  cursor: z.output<typeof cursorSchema>,
): string {
  return Buffer.from(JSON.stringify(cursorSchema.parse(cursor))).toString(
    'base64url',
  );
}

export function decodeConnectionUsageCursor(
  value: string,
  workspaceId: string,
  connectionId: string,
) {
  try {
    const cursor = cursorSchema.parse(
      JSON.parse(Buffer.from(value, 'base64url').toString('utf8')),
    );
    if (
      cursor.workspaceId !== workspaceId ||
      cursor.connectionId !== connectionId ||
      encodeConnectionUsageCursor(cursor) !== value
    )
      throw new InvalidConnectionCursorError();
    return Object.freeze({ workflowVersionId: cursor.workflowVersionId });
  } catch {
    throw new InvalidConnectionCursorError();
  }
}

export class ListConnectionUsageUseCase {
  public constructor(
    private readonly persistence: ConnectionUsageDatabase,
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
      allowedWorkspaceStatuses: ['active'],
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

@Controller('v1/workspaces/:workspaceId/connections/:connectionId/usage')
export class ConnectionUsageController {
  public constructor(private readonly usage: ListConnectionUsageUseCase) {}

  @Get()
  @RateLimit('authenticated_read')
  @UseGuards(SessionAuthenticationGuard, ConnectionReadGuard)
  public list(
    @Req() request: ConnectionRequest,
    @Param() params: unknown,
    @Query() query: unknown,
  ) {
    const route = connectionIdParamSchema.parse(params);
    const input = connectionListQuerySchema.parse(query ?? {});
    return this.usage.execute({
      ...projectAuthenticatedWorkspaceContext(request, route.workspaceId),
      routeWorkspaceId: route.workspaceId,
      connectionId: route.connectionId,
      ...(input.limit === undefined ? {} : { limit: input.limit }),
      ...(input.after === undefined ? {} : { after: input.after }),
    });
  }
}
