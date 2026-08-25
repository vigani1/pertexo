import { createHash, randomUUID } from 'node:crypto';

import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Injectable,
  Param,
  Post,
  Put,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  failureNotificationDestinationAppendVersionRequestSchema,
  failureNotificationDestinationCreateRequestSchema,
  failureNotificationDestinationStatusRequestSchema,
  workflowFailureNotificationPolicyRequestSchema,
} from '@pertexo/contracts';
import { idempotencyKeySchema } from '@pertexo/contracts/identity-workspace';
import type { FailureNotificationDestinationDatabase } from '@pertexo/database';
import { z } from 'zod';

import {
  CsrfProtectionGuard,
  SessionAuthenticationGuard,
  authenticatedSession,
  readHeader,
  requestIdentifier,
  traceIdentifier,
} from '../identity-workspace/index.js';
import { throwConnectionApplicationError } from './errors.js';
import {
  ConnectionManageGuard,
  FailureNotificationWorkflowEditGuard,
} from './guards.js';
import {
  CONNECTION_OPERATION,
  NOOP_CONNECTION_TELEMETRY,
  type ConnectionTelemetry,
} from './telemetry.js';
import type { ConnectionRequest } from './types.js';

const paramsSchema = z.looseObject({
  workspaceId: z.uuid(),
  destinationId: z.uuid().optional(),
  workflowId: z.uuid().optional(),
});

function command(request: ConnectionRequest, workspaceId: string) {
  const traceId = traceIdentifier(request);
  return {
    workspaceId,
    actorId: authenticatedSession(request).userId,
    requestId: requestIdentifier(request),
    ...(traceId === undefined ? {} : { traceId }),
  };
}

function idempotentCommand(
  request: ConnectionRequest,
  workspaceId: string,
  value: unknown,
) {
  return {
    ...command(request, workspaceId),
    idempotencyKey: idempotencyKeySchema.parse(
      readHeader(request, 'idempotency-key'),
    ),
    requestHash: createHash('sha256')
      .update(JSON.stringify(value))
      .digest('hex'),
  };
}

function response(
  record: Awaited<ReturnType<FailureNotificationDestinationDatabase['get']>>,
) {
  return {
    ...record,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  };
}

@Injectable()
export class FailureNotificationDestinationUseCases {
  public constructor(
    private readonly database: FailureNotificationDestinationDatabase,
    private readonly telemetry: ConnectionTelemetry = NOOP_CONNECTION_TELEMETRY,
  ) {}

  public async create(
    request: ConnectionRequest,
    workspaceId: string,
    body: z.output<typeof failureNotificationDestinationCreateRequestSchema>,
  ) {
    return this.telemetry.measure(
      CONNECTION_OPERATION.destinationCreate,
      async () =>
        response(
          await this.database.create({
            ...idempotentCommand(request, workspaceId, body),
            destinationId: randomUUID(),
            config: body,
          }),
        ),
    );
  }
  public async list(request: ConnectionRequest, workspaceId: string) {
    const records = await this.database.list(command(request, workspaceId));
    return { items: records.map(response) };
  }
  public async get(
    request: ConnectionRequest,
    workspaceId: string,
    destinationId: string,
  ) {
    return response(
      await this.database.get({
        ...command(request, workspaceId),
        destinationId,
      }),
    );
  }
  public async append(
    request: ConnectionRequest,
    workspaceId: string,
    destinationId: string,
    body: z.output<
      typeof failureNotificationDestinationAppendVersionRequestSchema
    >,
  ) {
    return this.telemetry.measure(
      CONNECTION_OPERATION.destinationAppend,
      async () =>
        response(
          await this.database.appendVersion({
            ...idempotentCommand(request, workspaceId, {
              destinationId,
              ...body,
            }),
            destinationId,
            expectedVersion: body.expectedVersion,
            config: body.config,
          }),
        ),
    );
  }
  public async status(
    request: ConnectionRequest,
    workspaceId: string,
    destinationId: string,
    body: z.output<typeof failureNotificationDestinationStatusRequestSchema>,
  ) {
    return this.telemetry.measure(
      CONNECTION_OPERATION.destinationStatus,
      async () =>
        response(
          await this.database.setStatus({
            ...idempotentCommand(request, workspaceId, {
              destinationId,
              ...body,
            }),
            destinationId,
            status: body.status,
          }),
        ),
    );
  }
  public setPolicy(
    request: ConnectionRequest,
    workspaceId: string,
    workflowId: string,
    body: z.output<typeof workflowFailureNotificationPolicyRequestSchema>,
  ) {
    return this.telemetry.measure(CONNECTION_OPERATION.policySet, () =>
      this.database.setWorkflowPolicy({
        ...idempotentCommand(request, workspaceId, { workflowId, ...body }),
        workflowId,
        destinationId: body.destinationId,
      }),
    );
  }
  public clearPolicy(
    request: ConnectionRequest,
    workspaceId: string,
    workflowId: string,
  ) {
    return this.telemetry.measure(CONNECTION_OPERATION.policyClear, () =>
      this.database.clearWorkflowPolicy({
        ...idempotentCommand(request, workspaceId, { workflowId }),
        workflowId,
      }),
    );
  }
}

@Controller('v1/workspaces/:workspaceId')
export class FailureNotificationDestinationsController {
  public constructor(
    private readonly useCases: FailureNotificationDestinationUseCases,
  ) {}

  @Post('failure-notification-destinations')
  @UseGuards(
    SessionAuthenticationGuard,
    ConnectionManageGuard,
    CsrfProtectionGuard,
  )
  @HttpCode(201)
  public async create(
    @Req() request: ConnectionRequest,
    @Param() params: unknown,
    @Body() body: unknown,
  ) {
    try {
      const route = paramsSchema.parse(params);
      return await this.useCases.create(
        request,
        route.workspaceId,
        failureNotificationDestinationCreateRequestSchema.parse(body),
      );
    } catch (error: unknown) {
      return throwConnectionApplicationError(error);
    }
  }
  @Get('failure-notification-destinations')
  @UseGuards(SessionAuthenticationGuard, FailureNotificationWorkflowEditGuard)
  public async list(
    @Req() request: ConnectionRequest,
    @Param() params: unknown,
  ) {
    try {
      return await this.useCases.list(
        request,
        paramsSchema.parse(params).workspaceId,
      );
    } catch (error: unknown) {
      return throwConnectionApplicationError(error);
    }
  }
  @Get('failure-notification-destinations/:destinationId')
  @UseGuards(SessionAuthenticationGuard, FailureNotificationWorkflowEditGuard)
  public async get(
    @Req() request: ConnectionRequest,
    @Param() params: unknown,
  ) {
    try {
      const route = paramsSchema.parse(params);
      return await this.useCases.get(
        request,
        route.workspaceId,
        z.uuid().parse(route.destinationId),
      );
    } catch (error: unknown) {
      return throwConnectionApplicationError(error);
    }
  }
  @Post('failure-notification-destinations/:destinationId/versions')
  @UseGuards(
    SessionAuthenticationGuard,
    ConnectionManageGuard,
    CsrfProtectionGuard,
  )
  public async append(
    @Req() request: ConnectionRequest,
    @Param() params: unknown,
    @Body() body: unknown,
  ) {
    try {
      const route = paramsSchema.parse(params);
      return await this.useCases.append(
        request,
        route.workspaceId,
        z.uuid().parse(route.destinationId),
        failureNotificationDestinationAppendVersionRequestSchema.parse(body),
      );
    } catch (error: unknown) {
      return throwConnectionApplicationError(error);
    }
  }
  @Put('failure-notification-destinations/:destinationId/status')
  @UseGuards(
    SessionAuthenticationGuard,
    ConnectionManageGuard,
    CsrfProtectionGuard,
  )
  public async status(
    @Req() request: ConnectionRequest,
    @Param() params: unknown,
    @Body() body: unknown,
  ) {
    try {
      const route = paramsSchema.parse(params);
      return await this.useCases.status(
        request,
        route.workspaceId,
        z.uuid().parse(route.destinationId),
        failureNotificationDestinationStatusRequestSchema.parse(body),
      );
    } catch (error: unknown) {
      return throwConnectionApplicationError(error);
    }
  }
  @Put('workflows/:workflowId/failure-notification-policy')
  @UseGuards(
    SessionAuthenticationGuard,
    FailureNotificationWorkflowEditGuard,
    CsrfProtectionGuard,
  )
  @HttpCode(204)
  public async setPolicy(
    @Req() request: ConnectionRequest,
    @Param() params: unknown,
    @Body() body: unknown,
  ) {
    try {
      const route = paramsSchema.parse(params);
      await this.useCases.setPolicy(
        request,
        route.workspaceId,
        z.uuid().parse(route.workflowId),
        workflowFailureNotificationPolicyRequestSchema.parse(body),
      );
    } catch (error: unknown) {
      return throwConnectionApplicationError(error);
    }
  }
  @Delete('workflows/:workflowId/failure-notification-policy')
  @UseGuards(
    SessionAuthenticationGuard,
    FailureNotificationWorkflowEditGuard,
    CsrfProtectionGuard,
  )
  @HttpCode(204)
  public async clearPolicy(
    @Req() request: ConnectionRequest,
    @Param() params: unknown,
  ) {
    try {
      const route = paramsSchema.parse(params);
      await this.useCases.clearPolicy(
        request,
        route.workspaceId,
        z.uuid().parse(route.workflowId),
      );
    } catch (error: unknown) {
      return throwConnectionApplicationError(error);
    }
  }
}
