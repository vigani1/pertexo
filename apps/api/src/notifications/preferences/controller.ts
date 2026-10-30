import {
  Body,
  Controller,
  Get,
  Put,
  Param,
  Req,
  UseGuards,
  Header,
  UseInterceptors,
} from '@nestjs/common';
import {
  workspaceIdentifierSchema,
  noticePreferencesRequestSchema,
  noticeDefaultsRequestSchema,
  noticeSubjectParamsSchema,
  noticeSubscriptionRequestSchema,
} from '@pertexo/contracts';
import {
  SessionAuthenticationGuard,
  CsrfProtectionGuard,
  authenticatedSession,
} from '../../workspaces/index.js';
import type { IdentityWorkspaceRequest } from '../../workspaces/types.js';
import {
  requestIdempotencyKey,
  withRequestOperationSignal,
} from '../../platform/http/index.js';
import type { AbortableRequest } from '../../platform/http/request-operation-signal.js';
import { RateLimit } from '../../platform/rate-limit/metadata.js';
import { NotificationChangeGuard, NotificationReadGuard } from '../guards.js';
import { NoticePreferencesService } from './service.js';
import { domainErrors } from '../../platform/http/problems/interceptor.js';
import { inboxFailure } from '../../problems/context/normalize.js';

type Request = IdentityWorkspaceRequest & AbortableRequest;
@UseInterceptors(domainErrors(inboxFailure))
@Controller('v1/workspaces/:workspaceId/notifications')
@UseGuards(SessionAuthenticationGuard, NotificationReadGuard)
@RateLimit('authenticated_read')
export class NoticePreferencesController {
  constructor(private readonly preferences: NoticePreferencesService) {}
  @Get('preferences')
  @Header('Cache-Control', 'private, no-store')
  read(@Req() request: Request, @Param('workspaceId') workspace: unknown) {
    const workspaceId = workspaceIdentifierSchema.parse(workspace);
    return withRequestOperationSignal(request, (signal) =>
      this.preferences.read({
        workspaceId,
        actorId: authenticatedSession(request).userId,
        signal,
      }),
    );
  }
  @Put('preferences')
  @Header('Cache-Control', 'private, no-store')
  @UseGuards(NotificationChangeGuard, CsrfProtectionGuard)
  @RateLimit('ordinary_mutation')
  replace(
    @Req() request: Request,
    @Param('workspaceId') workspace: unknown,
    @Body() body: unknown,
  ) {
    const workspaceId = workspaceIdentifierSchema.parse(workspace);
    const input = noticePreferencesRequestSchema.parse(body);
    const idempotencyKey = requestIdempotencyKey(request.headers);
    return withRequestOperationSignal(request, (signal) =>
      this.preferences.replace({
        workspaceId,
        actorId: authenticatedSession(request).userId,
        ...input,
        idempotencyKey,
        signal,
      }),
    );
  }
  @Put('defaults')
  @Header('Cache-Control', 'private, no-store')
  @UseGuards(NotificationChangeGuard, CsrfProtectionGuard)
  @RateLimit('ordinary_mutation')
  defaults(
    @Req() request: Request,
    @Param('workspaceId') workspace: unknown,
    @Body() body: unknown,
  ) {
    const workspaceId = workspaceIdentifierSchema.parse(workspace);
    const input = noticeDefaultsRequestSchema.parse(body);
    const idempotencyKey = requestIdempotencyKey(request.headers);
    return withRequestOperationSignal(request, (signal) =>
      this.preferences.replaceDefaults({
        workspaceId,
        actorId: authenticatedSession(request).userId,
        ...input,
        idempotencyKey,
        signal,
      }),
    );
  }
  @Get('subjects/:subjectKind/:subjectId')
  @Header('Cache-Control', 'private, no-store')
  subscription(@Req() request: Request, @Param() params: unknown) {
    const route = noticeSubjectParamsSchema.parse(params);
    return withRequestOperationSignal(request, (signal) =>
      this.preferences.subscription({
        ...route,
        actorId: authenticatedSession(request).userId,
        signal,
      }),
    );
  }
  @Put('subjects/:subjectKind/:subjectId')
  @Header('Cache-Control', 'private, no-store')
  @UseGuards(NotificationChangeGuard, CsrfProtectionGuard)
  @RateLimit('ordinary_mutation')
  replaceSubscription(
    @Req() request: Request,
    @Param() params: unknown,
    @Body() body: unknown,
  ) {
    const route = noticeSubjectParamsSchema.parse(params);
    const input = noticeSubscriptionRequestSchema.parse(body);
    const idempotencyKey = requestIdempotencyKey(request.headers);
    return withRequestOperationSignal(request, (signal) =>
      this.preferences.replaceSubscription({
        ...route,
        actorId: authenticatedSession(request).userId,
        ...input,
        idempotencyKey,
        signal,
      }),
    );
  }
}
