import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
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
} from '@pertexo/contracts/connections';
import { z } from 'zod';

import {
  CsrfProtectionGuard,
  SessionAuthenticationGuard,
} from '../identity-workspace/index.js';
import { projectAuthenticatedWorkspaceContext } from '../identity-workspace/authenticated-command-context.js';
import { parseIdempotencyKey } from '../platform/http/index.js';
import { RateLimit } from '../platform/rate-limit/metadata.js';
import {
  ConnectionManageGuard,
  FailureNotificationWorkflowEditGuard,
} from './guards.js';
import {
  FailureNotificationDestinationUseCases,
  type ClearWorkflowFailureNotificationPolicyInput,
} from './failure-notification-destinations.js';
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

function requestCommand(
  request: ConnectionRequest,
  routeWorkspaceId: string,
): Omit<
  ClearWorkflowFailureNotificationPolicyInput,
  'idempotencyKey' | 'workflowId'
> {
  return {
    ...projectAuthenticatedWorkspaceContext(request, routeWorkspaceId),
    routeWorkspaceId,
  };
}

function requestIdempotencyKey(request: ConnectionRequest): string {
  const header = Object.entries(request.headers ?? {}).find(
    ([name]) => name.toLowerCase() === 'idempotency-key',
  )?.[1];
  return parseIdempotencyKey(header);
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
    const route = workspaceParamsSchema.parse(params);
    return this.useCases.list({
      ...requestCommand(request, route.workspaceId),
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
