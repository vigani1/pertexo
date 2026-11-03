import { Controller } from '@nestjs/common';
import {
  connectionRoutes,
  failureNotificationRoutes,
} from '@pertexo/contracts/server';
import { UnconfiguredRoute } from '../../workspaces/http/route.js';
import {
  applicationError,
  throwApplicationError,
} from '../../platform/http/application-error.js';

/** The two lists the web app opens with, when connections aren't configured: each says so. */
@Controller()
export class UnconfiguredConnectionsController {
  @UnconfiguredRoute(connectionRoutes.list)
  public connections(): never {
    return throwApplicationError(applicationError('connection.not_configured'));
  }

  @UnconfiguredRoute(failureNotificationRoutes.list)
  public destinations(): never {
    return throwApplicationError(applicationError('connection.not_configured'));
  }
}
