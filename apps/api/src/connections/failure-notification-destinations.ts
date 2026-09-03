import { createHash } from 'node:crypto';

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
} from '@pertexo/contracts';
import { idempotencyKeySchema } from '@pertexo/contracts/identity-workspace';
import {
  generatePersistedId,
  type FailureNotificationDestinationDatabase,
} from '@pertexo/database/api';
import { z } from 'zod';

import {
  CsrfProtectionGuard,
  SessionAuthenticationGuard,
  authenticatedSession,
  readHeader,
  requestIdentifier,
  traceIdentifier,
} from '../identity-workspace/index.js';
import { RateLimit } from '../platform/rate-limit/metadata.js';
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
): FailureNotificationDestinationResponse {
  return {
    ...record,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  };
}

type DestinationRequestInput = Readonly<{
  request: ConnectionRequest;
  workspaceId: string;
}>;
export type CreateFailureNotificationDestinationInput =
  DestinationRequestInput &
    Readonly<{
      body: z.output<typeof failureNotificationDestinationCreateRequestSchema>;
    }>;
export type ListFailureNotificationDestinationsInput = DestinationRequestInput;
export type GetFailureNotificationDestinationInput = DestinationRequestInput &
  Readonly<{ destinationId: string }>;
export type AppendFailureNotificationDestinationVersionInput =
  GetFailureNotificationDestinationInput &
    Readonly<{
      body: z.output<
        typeof failureNotificationDestinationAppendVersionRequestSchema
      >;
    }>;
export type SetFailureNotificationDestinationStatusInput =
  GetFailureNotificationDestinationInput &
    Readonly<{
      body: z.output<typeof failureNotificationDestinationStatusRequestSchema>;
    }>;
export type SetWorkflowFailureNotificationPolicyInput =
  DestinationRequestInput &
    Readonly<{
      workflowId: string;
      body: z.output<typeof workflowFailureNotificationPolicyRequestSchema>;
    }>;
export type ClearWorkflowFailureNotificationPolicyInput =
  DestinationRequestInput & Readonly<{ workflowId: string }>;

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
            ...idempotentCommand(input.request, input.workspaceId, input.body),
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
    const records = await this.database.list(
      command(input.request, input.workspaceId),
    );
    return { items: records.map(response) };
  }
  public async get(
    input: GetFailureNotificationDestinationInput,
  ): Promise<FailureNotificationDestinationResponse> {
    return response(
      await this.database.get({
        ...command(input.request, input.workspaceId),
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
            ...idempotentCommand(input.request, input.workspaceId, {
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
            ...idempotentCommand(input.request, input.workspaceId, {
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
        ...idempotentCommand(input.request, input.workspaceId, {
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
        ...idempotentCommand(input.request, input.workspaceId, {
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
      request,
      workspaceId: route.workspaceId,
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
      request,
      workspaceId: workspaceParamsSchema.parse(params).workspaceId,
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
      request,
      workspaceId: route.workspaceId,
      destinationId: route.destinationId,
    });
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
    const route = destinationParamsSchema.parse(params);
    return this.useCases.append({
      request,
      workspaceId: route.workspaceId,
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
      request,
      workspaceId: route.workspaceId,
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
      request,
      workspaceId: route.workspaceId,
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
      request,
      workspaceId: route.workspaceId,
      workflowId: route.workflowId,
    });
  }
}
