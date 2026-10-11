import { Controller, Get, Post, UseGuards } from '@nestjs/common';
import {
  CsrfProtectionGuard,
  SessionAuthenticationGuard,
} from '../workspaces/index.js';
import {
  applicationError,
  throwApplicationError,
} from '../platform/http/application-error.js';
import { RateLimit } from '../platform/rate-limit/metadata.js';
import { WebhookReadGuard, WebhookUpdateGuard } from './guards.js';

@Controller('v1/workspaces/:workspaceId/workflows/:workflowId/triggers')
@RateLimit('authenticated_read')
export class UnconfiguredWebhooksController {
  @Get(['', ':triggerId/webhook/deliveries'])
  @UseGuards(SessionAuthenticationGuard, WebhookReadGuard)
  public read(): never {
    return throwApplicationError(applicationError('webhook.not_configured'));
  }

  @Post([
    ':triggerId/webhook/provision',
    ':triggerId/webhook/rotate-endpoint',
    ':triggerId/webhook/rotate-secret',
  ])
  @RateLimit('trigger_mutation')
  @UseGuards(
    SessionAuthenticationGuard,
    WebhookUpdateGuard,
    CsrfProtectionGuard,
  )
  public command(): never {
    return throwApplicationError(applicationError('webhook.not_configured'));
  }
}
