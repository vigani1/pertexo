import { Controller, Delete, Get, Post, UseGuards } from '@nestjs/common';
import {
  CsrfProtectionGuard,
  SessionAuthenticationGuard,
} from '../../workspaces/index.js';
import {
  applicationError,
  throwApplicationError,
} from '../../platform/http/application-error.js';
import { RateLimit } from '../../platform/rate-limit/metadata.js';
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
    ':triggerId/webhook/authentication',
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

@Controller(
  'v1/workspaces/:workspaceId/workflows/:workflowId/draft/nodes/:nodeId/webhook-test-events',
)
@UseGuards(SessionAuthenticationGuard, WebhookUpdateGuard)
export class UnconfiguredWebhookTestsController {
  @Get(':id')
  @RateLimit('authenticated_read')
  read(): never {
    return throwApplicationError(applicationError('webhook.not_configured'));
  }
  @Post()
  @RateLimit('trigger_mutation')
  @UseGuards(CsrfProtectionGuard)
  start(): never {
    return throwApplicationError(applicationError('webhook.not_configured'));
  }
  @Delete(':id')
  @RateLimit('trigger_mutation')
  @UseGuards(CsrfProtectionGuard)
  stop(): never {
    return throwApplicationError(applicationError('webhook.not_configured'));
  }
}
