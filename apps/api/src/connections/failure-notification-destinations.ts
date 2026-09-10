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
  failureNotificationDestinationListResponseSchema,
  failureNotificationDestinationStatusRequestSchema,
  type FailureNotificationDestinationResponse,
  workflowFailureNotificationPolicyRequestSchema,
} from '@pertexo/contracts/connections';
import {
  generatePersistedId,
  type FailureNotificationDestinationDatabase,
} from '@pertexo/database/api';
import { z } from 'zod';

import {
  CsrfProtectionGuard,
  SessionAuthenticationGuard,
  authenticatedSession,
  requestIdentifier,
  traceIdentifier,
} from '../identity-workspace/index.js';
import { RateLimit } from '../platform/rate-limit/metadata.js';
import { parseIdempotencyKey } from '../platform/http/index.js';
import { createActorContext } from '../workspaces/index.js';
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
import {
  hashRequest,
  type ConnectionCommandInput,
} from './use-case-support.js';

const workspaceParamsShape = { workspaceId: z.uuid() };
const workspaceParamsSchema = z
  .object(workspaceParamsShape)
  .strict()
  .readonly();
const destinationParamsSchema = z
  .object({ ...workspaceParamsShape, destinationId: z.uuid() })
  .strict()
  .readonly();
const workflowPolicyParamsSchema = z
  .object({ ...workspaceParamsShape, workflowId: z.uuid() })
  .strict()
  .readonly();

function requestCommand(
  request: ConnectionRequest,
  routeWorkspaceId: string,
): ConnectionCommandInput {
  const traceId = traceIdentifier(request);
  const session = authenticatedSession(request);
  const requestId = requestIdentifier(request);
  return {
    actor:
      request.authorizedWorkspace?.actor ??
      createActorContext({
        actorId: session.userId,
        workspaceId: routeWorkspaceId,
        sessionId: session.sessionId,
        requestId,
        ...(traceId === undefined ? {} : { traceId }),
      }),
    routeWorkspaceId,
    requestId,
    ...(traceId === undefined ? {} : { traceId }),
  };
}

function databaseCommand(input: DestinationCommandInput) {
  return {
    workspaceId: input.routeWorkspaceId,
    actorId: input.actor.actorId,
    ...(input.requestId === undefined ? {} : { requestId: input.requestId }),
    ...(input.traceId === undefined ? {} : { traceId: input.traceId }),
  };
}

function requestIdempotencyKey(request: ConnectionRequest): string {
  const header = Object.entries(request.headers ?? {}).find(
    ([name]) => name.toLowerCase() === 'idempotency-key',
  )?.[1];
  return parseIdempotencyKey(header);
}

function idempotentCommand(input: DestinationMutationInput, value: unknown) {
  return {
    ...databaseCommand(input),
    idempotencyKey: input.idempotencyKey,
    requestHash: hashRequest(value),
  };
}

function response(
  record: Awaited<ReturnType<FailureNotificationDestinationDatabase['get']>>,
): FailureNotificationDestinationResponse {
  return {
    ...record,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  };
}

type DestinationCommandInput = Pick<
  ConnectionCommandInput,
  'actor' | 'routeWorkspaceId' | 'requestId' | 'traceId'
>;
type DestinationMutationInput = DestinationCommandInput &
  Readonly<{ idempotencyKey: string }>;
export type CreateFailureNotificationDestinationInput =
  DestinationMutationInput &
    Readonly<{
      body: z.output<typeof failureNotificationDestinationCreateRequestSchema>;
    }>;
export type ListFailureNotificationDestinationsInput = DestinationCommandInput;
export type GetFailureNotificationDestinationInput = DestinationCommandInput &
  Readonly<{ destinationId: string }>;
export type AppendFailureNotificationDestinationVersionInput =
  GetFailureNotificationDestinationInput &
    DestinationMutationInput &
    Readonly<{
      body: z.output<
        typeof failureNotificationDestinationAppendVersionRequestSchema
      >;
    }>;
export type SetFailureNotificationDestinationStatusInput =
  GetFailureNotificationDestinationInput &
    DestinationMutationInput &
    Readonly<{
      body: z.output<typeof failureNotificationDestinationStatusRequestSchema>;
    }>;
export type SetWorkflowFailureNotificationPolicyInput =
  DestinationMutationInput &
    Readonly<{
      workflowId: string;
      body: z.output<typeof workflowFailureNotificationPolicyRequestSchema>;
    }>;
export type ClearWorkflowFailureNotificationPolicyInput =
  DestinationMutationInput & Readonly<{ workflowId: string }>;

@Injectable()
export class FailureNotificationDestinationUseCases {
  public constructor(
    private readonly database: FailureNotificationDestinationDatabase,
    private readonly telemetry: ConnectionTelemetry = NOOP_CONNECTION_TELEMETRY,
  ) {}

  public create(
    input: CreateFailureNotificationDestinationInput,
  ): Promise<FailureNotificationDestinationResponse> {
    return this.telemetry.measure(
      CONNECTION_OPERATION.destinationCreate,
      async () =>
        response(
          await this.database.create({
            ...idempotentCommand(input, input.body),
            destinationId: generatePersistedId(),
            config: input.body,
          }),
        ),
    );
  }
  public async list(
    input: ListFailureNotificationDestinationsInput,
  ): Promise<
    z.output<typeof failureNotificationDestinationListResponseSchema>
  > {
    const records = await this.database.list(databaseCommand(input));
    return { items: records.map(response) };
  }
  public async get(
    input: GetFailureNotificationDestinationInput,
  ): Promise<FailureNotificationDestinationResponse> {
    return response(
      await this.database.get({
        ...databaseCommand(input),
        destinationId: input.destinationId,
      }),
    );
  }
  public append(
    input: AppendFailureNotificationDestinationVersionInput,
  ): Promise<FailureNotificationDestinationResponse> {
    return this.telemetry.measure(
      CONNECTION_OPERATION.destinationAppend,
      async () =>
        response(
          await this.database.appendVersion({
            ...idempotentCommand(input, {
              destinationId: input.destinationId,
              ...input.body,
            }),
            destinationId: input.destinationId,
            expectedVersion: input.body.expectedVersion,
            config: input.body.config,
          }),
        ),
    );
  }
  public status(
    input: SetFailureNotificationDestinationStatusInput,
  ): Promise<FailureNotificationDestinationResponse> {
    return this.telemetry.measure(
      CONNECTION_OPERATION.destinationStatus,
      async () =>
        response(
          await this.database.setStatus({
            ...idempotentCommand(input, {
              destinationId: input.destinationId,
              ...input.body,
            }),
            destinationId: input.destinationId,
            status: input.body.status,
          }),
        ),
    );
  }
  public setPolicy(
    input: SetWorkflowFailureNotificationPolicyInput,
  ): Promise<void> {
    return this.telemetry.measure(CONNECTION_OPERATION.policySet, () =>
      this.database.setWorkflowPolicy({
        ...idempotentCommand(input, {
          workflowId: input.workflowId,
          ...input.body,
        }),
        workflowId: input.workflowId,
        destinationId: input.body.destinationId,
      }),
    );
  }
  public clearPolicy(
    input: ClearWorkflowFailureNotificationPolicyInput,
  ): Promise<void> {
    return this.telemetry.measure(CONNECTION_OPERATION.policyClear, () =>
      this.database.clearWorkflowPolicy({
        ...idempotentCommand(input, {
          workflowId: input.workflowId,
        }),
        workflowId: input.workflowId,
      }),
    );
  }
}

@Controller('v1/workspaces/:workspaceId')
@RateLimit('ordinary_mutation')
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
    const route = workspaceParamsSchema.parse(params);
    return this.useCases.create({
      ...requestCommand(request, route.workspaceId),
      idempotencyKey: requestIdempotencyKey(request),
      body: failureNotificationDestinationCreateRequestSchema.parse(body),
    });
  }
  @Get('failure-notification-destinations')
  @RateLimit('authenticated_read')
  @UseGuards(SessionAuthenticationGuard, FailureNotificationWorkflowEditGuard)
  public async list(
    @Req() request: ConnectionRequest,
    @Param() params: unknown,
  ) {
    return this.useCases.list({
      ...requestCommand(
        request,
        workspaceParamsSchema.parse(params).workspaceId,
      ),
    });
  }
  @Get('failure-notification-destinations/:destinationId')
  @RateLimit('authenticated_read')
  @UseGuards(SessionAuthenticationGuard, FailureNotificationWorkflowEditGuard)
  public async get(
    @Req() request: ConnectionRequest,
    @Param() params: unknown,
  ) {
    const route = destinationParamsSchema.parse(params);
    return this.useCases.get({
      ...requestCommand(request, route.workspaceId),
      destinationId: route.destinationId,
    });
  }
  @Post('failure-notification-destinations/:destinationId/versions')
  @HttpCode(200)
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
    const route = destinationParamsSchema.parse(params);
    return this.useCases.append({
      ...requestCommand(request, route.workspaceId),
      idempotencyKey: requestIdempotencyKey(request),
      destinationId: route.destinationId,
      body: failureNotificationDestinationAppendVersionRequestSchema.parse(
        body,
      ),
    });
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
    const route = destinationParamsSchema.parse(params);
    return this.useCases.status({
      ...requestCommand(request, route.workspaceId),
      idempotencyKey: requestIdempotencyKey(request),
      destinationId: route.destinationId,
      body: failureNotificationDestinationStatusRequestSchema.parse(body),
    });
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
    const route = workflowPolicyParamsSchema.parse(params);
    await this.useCases.setPolicy({
      ...requestCommand(request, route.workspaceId),
      idempotencyKey: requestIdempotencyKey(request),
      workflowId: route.workflowId,
      body: workflowFailureNotificationPolicyRequestSchema.parse(body),
    });
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
    const route = workflowPolicyParamsSchema.parse(params);
    await this.useCases.clearPolicy({
      ...requestCommand(request, route.workspaceId),
      idempotencyKey: requestIdempotencyKey(request),
      workflowId: route.workflowId,
    });
  }
}
