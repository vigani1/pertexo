import { Controller, Get, UseGuards } from '@nestjs/common';
import { SessionAuthenticationGuard } from '../../workspaces/index.js';
import {
  applicationError,
  throwApplicationError,
} from '../../platform/http/application-error.js';
import { RateLimit } from '../../platform/rate-limit/metadata.js';
import { ConnectionReadGuard, FailureNotificationReadGuard } from './guards.js';

@Controller('v1/workspaces/:workspaceId')
@RateLimit('authenticated_read')
export class UnconfiguredConnectionsController {
  @Get('connections')
  @UseGuards(SessionAuthenticationGuard, ConnectionReadGuard)
  public connections(): never {
    return throwApplicationError(applicationError('connection.not_configured'));
  }

  @Get('failure-notification-destinations')
  @UseGuards(SessionAuthenticationGuard, FailureNotificationReadGuard)
  public destinations(): never {
    return throwApplicationError(applicationError('connection.not_configured'));
  }
}
