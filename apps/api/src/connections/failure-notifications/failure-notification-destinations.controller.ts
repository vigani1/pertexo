import { Controller, Req, UseInterceptors } from '@nestjs/common';
import {
  failureNotificationRoutes as routes,
  type RouteInput,
} from '@pertexo/contracts/server';

import { In, Route } from '../../platform/http/route.js';
import { TestConnectionService } from '../testing/test-connection.js';
import {
  applicationError,
  throwApplicationError,
} from '../../platform/http/application-error.js';
import { withRequestOperationSignal } from '../../platform/http/index.js';
import { FailureNotificationDestinationServices } from './destinations.js';
import type { ConnectionRequest } from '../connection-request.js';
import { domainErrors } from '../../platform/http/problems/interceptor.js';
import { connectionFailure } from '../../problems/context/normalize-context-errors.js';
import {
  Caller,
  serviceCaller,
  type WorkspaceCaller,
} from '../../workspaces/request/caller.js';

@UseInterceptors(domainErrors(connectionFailure))
@Controller()
export class FailureNotificationDestinationsController {
  public constructor(
    private readonly services: FailureNotificationDestinationServices,
    private readonly testConnection: TestConnectionService,
  ) {}

  @Route(routes.create)
  public create(
    @Caller() caller: WorkspaceCaller,
    @In() { body, idempotencyKey }: RouteInput<typeof routes.create>,
  ) {
    return this.services.create({
      ...serviceCaller(caller),
      idempotencyKey,
      body,
    });
  }

  @Route(routes.list)
  public list(
    @Caller() caller: WorkspaceCaller,
    @In() { query }: RouteInput<typeof routes.list>,
  ) {
    return this.services.list({ ...serviceCaller(caller), ...query });
  }

  @Route(routes.get)
  public get(
    @Caller() caller: WorkspaceCaller,
    @In() { params }: RouteInput<typeof routes.get>,
  ) {
    return this.services.get({
      ...serviceCaller(caller),
      destinationId: params.destinationId,
    });
  }

  /** Only the version the person reviewed is sent a test. */
  @Route(routes.test)
  public async test(
    @Req() request: ConnectionRequest,
    @Caller() caller: WorkspaceCaller,
    @In() { params, body, idempotencyKey }: RouteInput<typeof routes.test>,
  ) {
    const scope = serviceCaller(caller);
    const destination = await this.services.get({
      ...scope,
      destinationId: params.destinationId,
    });
    if (destination.currentVersion !== body.expectedVersion)
      return throwApplicationError(
        applicationError('connection.conflict', {
          safeDetail:
            'The alert destination changed. Review it before sending a test.',
        }),
      );
    return withRequestOperationSignal(request, (signal) =>
      this.testConnection.executeDestination(
        { ...scope, idempotencyKey, signal },
        destination,
      ),
    );
  }

  @Route(routes.appendVersion)
  public append(
    @Caller() caller: WorkspaceCaller,
    @In()
    { params, body, idempotencyKey }: RouteInput<typeof routes.appendVersion>,
  ) {
    return this.services.append({
      ...serviceCaller(caller),
      idempotencyKey,
      destinationId: params.destinationId,
      body,
    });
  }

  @Route(routes.setStatus)
  public status(
    @Caller() caller: WorkspaceCaller,
    @In()
    { params, body, idempotencyKey }: RouteInput<typeof routes.setStatus>,
  ) {
    return this.services.status({
      ...serviceCaller(caller),
      idempotencyKey,
      destinationId: params.destinationId,
      body,
    });
  }

  @Route(routes.policy)
  public getPolicy(
    @Caller() caller: WorkspaceCaller,
    @In() { params }: RouteInput<typeof routes.policy>,
  ) {
    return this.services.getPolicy({
      ...serviceCaller(caller),
      workflowId: params.workflowId,
    });
  }

  @Route(routes.setPolicy)
  public async setPolicy(
    @Caller() caller: WorkspaceCaller,
    @In()
    { params, body, idempotencyKey }: RouteInput<typeof routes.setPolicy>,
  ) {
    await this.services.setPolicy({
      ...serviceCaller(caller),
      idempotencyKey,
      workflowId: params.workflowId,
      body,
    });
  }

  @Route(routes.clearPolicy)
  public async clearPolicy(
    @Caller() caller: WorkspaceCaller,
    @In() { params, idempotencyKey }: RouteInput<typeof routes.clearPolicy>,
  ) {
    await this.services.clearPolicy({
      ...serviceCaller(caller),
      idempotencyKey,
      workflowId: params.workflowId,
    });
  }
}
