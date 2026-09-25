import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  SCHEDULE_FIRE_TIME_DEFAULT_COUNT,
  scheduleManagementCommandRequestSchema,
  scheduleNextRunsQuerySchema,
  scheduleOccurrenceListQuerySchema,
  schedulePreviewRequestSchema,
} from '@pertexo/contracts/schedules';
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
  throwApplicationError,
  parseIdempotencyKey,
} from '../platform/http/index.js';
import { ScheduleReadGuard, ScheduleUpdateGuard } from './guards.js';
import { ScheduleManagementService } from './service.js';

const routeShape = { workspaceId: z.uuid(), workflowId: z.uuid() };
const routeSchema = z.object(routeShape).strict().readonly();
const triggerRouteSchema = z
  .object({ ...routeShape, triggerId: z.uuid() })
  .strict()
  .readonly();
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

  @Get(':triggerId/schedule/occurrences')
  @RateLimit('authenticated_read')
  @UseGuards(SessionAuthenticationGuard, ScheduleReadGuard)
  public occurrences(
    @Req() request: Request,
    @Param() params: unknown,
    @Query() query: unknown,
  ) {
    const route = triggerRouteSchema.parse(params);
    const page = scheduleOccurrenceListQuerySchema.parse(query ?? {});
    return this.service.listOccurrences({
      ...route,
      actorId: authenticatedSession(request).userId,
      ...(page.limit === undefined ? {} : { limit: page.limit }),
      ...(page.after === undefined ? {} : { after: page.after }),
    });
  }

  @Get(':triggerId/schedule/next-runs')
  @RateLimit('authenticated_read')
  @UseGuards(SessionAuthenticationGuard, ScheduleReadGuard)
  public nextRuns(
    @Req() request: Request,
    @Param() params: unknown,
    @Query() query: unknown,
  ) {
    const route = triggerRouteSchema.parse(params);
    const { count } = scheduleNextRunsQuerySchema.parse(query ?? {});
    return this.service.nextRuns({
      ...route,
      actorId: authenticatedSession(request).userId,
      count: count ?? SCHEDULE_FIRE_TIME_DEFAULT_COUNT,
    });
  }

  /** Side-effect free, but computed per request like draft validation. */
  @Post('schedules/preview')
  @HttpCode(200)
  @RateLimit('workflow_compile')
  @UseGuards(SessionAuthenticationGuard, ScheduleReadGuard, CsrfProtectionGuard)
  public preview(
    @Req() request: Request,
    @Param() params: unknown,
    @Body() body: unknown,
  ) {
    const route = routeSchema.parse(params);
    const input = schedulePreviewRequestSchema.parse(body);
    return this.service.previewRuns({
      ...route,
      actorId: authenticatedSession(request).userId,
      config: input.config,
      count: input.count ?? SCHEDULE_FIRE_TIME_DEFAULT_COUNT,
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
    const route = triggerRouteSchema.parse(params);
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
