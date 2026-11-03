import { Controller } from '@nestjs/common';
import { webhookRoutes as routes } from '@pertexo/contracts/server';
import { UnconfiguredRoute } from '../../workspaces/http/route.js';
import {
  applicationError,
  throwApplicationError,
} from '../../platform/http/application-error.js';

function notConfigured(): never {
  return throwApplicationError(applicationError('webhook.not_configured'));
}

/** The same routes when webhooks aren't configured: each says so. */
@Controller()
export class UnconfiguredWebhooksController {
  @UnconfiguredRoute(routes.list)
  public list(): never {
    return notConfigured();
  }

  @UnconfiguredRoute(routes.deliveries)
  public deliveries(): never {
    return notConfigured();
  }

  @UnconfiguredRoute(routes.provision)
  public provision(): never {
    return notConfigured();
  }

  @UnconfiguredRoute(routes.configureAuthentication)
  public configureAuthentication(): never {
    return notConfigured();
  }

  @UnconfiguredRoute(routes.rotateEndpoint)
  public rotateEndpoint(): never {
    return notConfigured();
  }

  @UnconfiguredRoute(routes.rotateSecret)
  public rotateSecret(): never {
    return notConfigured();
  }
}

@Controller()
export class UnconfiguredWebhookTestsController {
  @UnconfiguredRoute(routes.startTest)
  public start(): never {
    return notConfigured();
  }

  @UnconfiguredRoute(routes.readTest)
  public read(): never {
    return notConfigured();
  }

  @UnconfiguredRoute(routes.stopTest)
  public stop(): never {
    return notConfigured();
  }
}
