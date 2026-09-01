import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { scheduleManagementCommandRequestSchema } from '@pertexo/contracts';
import { z } from 'zod';

import {
  CsrfProtectionGuard,
  SessionAuthenticationGuard,
  authenticatedSession,
  requestIdentifier,
  traceIdentifier,
} from '../identity-workspace/index.js';
import type { IdentityWorkspaceRequest } from '../identity-workspace/types.js';
import { RateLimit } from '../platform/rate-limit/metadata.js';
import {
  applicationError,
  parseIdempotencyKey,
} from '../platform/http/index.js';
import { ScheduleReadGuard, ScheduleUpdateGuard } from './guards.js';
import { ScheduleManagementService } from './service.js';

const routeSchema = z.object({ workspaceId: z.uuid(), workflowId: z.uuid() });
const commandRouteSchema = routeSchema.extend({ triggerId: z.uuid() });
type Request = IdentityWorkspaceRequest;

@Controller('v1/workspaces/:workspaceId/workflows/:workflowId/triggers')
@RateLimit('trigger_mutation')
export class ScheduleManagementController {
  public constructor(private readonly service: ScheduleManagementService) {}

  @Get('schedules')
  @RateLimit('authenticated_read')
  @UseGuards(SessionAuthenticationGuard, ScheduleReadGuard)
  public list(@Req() request: Request, @Param() params: unknown) {
    const route = routeSchema.parse(params);
    return this.service.list({
      ...route,
      actorId: authenticatedSession(request).userId,
    });
  }

  @Post(':triggerId/schedule/enable')
  @HttpCode(200)
  @UseGuards(
    SessionAuthenticationGuard,
    ScheduleUpdateGuard,
    CsrfProtectionGuard,
  )
  public enable(
    @Req() request: Request,
    @Param() params: unknown,
    @Body() body: unknown,
  ) {
    return this.command(true, request, params, body);
  }

  @Post(':triggerId/schedule/disable')
  @HttpCode(200)
  @UseGuards(
    SessionAuthenticationGuard,
    ScheduleUpdateGuard,
    CsrfProtectionGuard,
  )
  public disable(
    @Req() request: Request,
    @Param() params: unknown,
    @Body() body: unknown,
  ) {
    return this.command(false, request, params, body);
  }

  private command(
    enabled: boolean,
    request: Request,
    params: unknown,
    body: unknown,
  ) {
    scheduleManagementCommandRequestSchema.parse(body);
    const route = commandRouteSchema.parse(params);
    const traceId = traceIdentifier(request);
    return this.service.setEnabled(
      {
        ...route,
        actorId: authenticatedSession(request).userId,
        idempotencyKey: scheduleIdempotencyKey(
          request.headers?.['idempotency-key'],
        ),
        requestId: requestIdentifier(request),
        ...(traceId === undefined ? {} : { traceId }),
      },
      enabled,
    );
  }
}

function scheduleIdempotencyKey(value: unknown): string {
  if (value === undefined)
    return throwApplicationError(
      applicationError('request.precondition_required', {
        safeDetail: 'Idempotency-Key is required.',
      }),
    );
  try {
    return parseIdempotencyKey(value);
  } catch (cause: unknown) {
    return throwApplicationError(
      applicationError('request.invalid', {
        safeDetail: 'Idempotency-Key must contain exactly one valid value.',
        cause,
      }),
    );
  }
}

function throwApplicationError(
  error: ReturnType<typeof applicationError>,
): never {
  // The global problem filter consumes the frozen application error value.
  // eslint-disable-next-line @typescript-eslint/only-throw-error
  throw error;
}
