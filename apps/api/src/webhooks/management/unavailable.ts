import { Controller } from '@nestjs/common';
import { webhookRoutes as routes } from '@pertexo/contracts/server';
import { Route } from '../../workspaces/http/route.js';
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
  @Route(routes.list)
  public list(): never {
    return notConfigured();
  }

  @Route(routes.deliveries)
  public deliveries(): never {
    return notConfigured();
  }

  @Route(routes.provision)
  public provision(): never {
    return notConfigured();
  }

  @Route(routes.configureAuthentication)
  public configureAuthentication(): never {
    return notConfigured();
  }

  @Route(routes.rotateEndpoint)
  public rotateEndpoint(): never {
    return notConfigured();
  }

  @Route(routes.rotateSecret)
  public rotateSecret(): never {
    return notConfigured();
  }
}

@Controller()
export class UnconfiguredWebhookTestsController {
  @Route(routes.startTest)
  public start(): never {
    return notConfigured();
  }

  @Route(routes.readTest)
  public read(): never {
    return notConfigured();
  }

  @Route(routes.stopTest)
  public stop(): never {
    return notConfigured();
  }
}
