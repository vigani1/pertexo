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
import { context } from '../http/connections.controller.js';
import { FailureNotificationDestinationServices } from './destinations.js';
import type { ConnectionRequest } from '../connection-request.js';
import { domainErrors } from '../../platform/http/problems/interceptor.js';
import { connectionFailure } from '../../problems/context/normalize-context-errors.js';

@UseInterceptors(domainErrors(connectionFailure))
@Controller()
export class FailureNotificationDestinationsController {
  public constructor(
    private readonly services: FailureNotificationDestinationServices,
    private readonly testConnection: TestConnectionService,
  ) {}

  @Route(routes.create)
  public create(
    @Req() request: ConnectionRequest,
    @In() { params, body, idempotencyKey }: RouteInput<typeof routes.create>,
  ) {
    return this.services.create({
      ...context(request, params),
      idempotencyKey,
      body,
    });
  }

  @Route(routes.list)
  public list(
    @Req() request: ConnectionRequest,
    @In() { params, query }: RouteInput<typeof routes.list>,
  ) {
    return this.services.list({ ...context(request, params), ...query });
  }

  @Route(routes.get)
  public get(
    @Req() request: ConnectionRequest,
    @In() { params }: RouteInput<typeof routes.get>,
  ) {
    return this.services.get({
      ...context(request, params),
      destinationId: params.destinationId,
    });
  }

  /** Only the version the person reviewed is sent a test. */
  @Route(routes.test)
  public async test(
    @Req() request: ConnectionRequest,
    @In() { params, body, idempotencyKey }: RouteInput<typeof routes.test>,
  ) {
    const caller = context(request, params);
    const destination = await this.services.get({
      ...caller,
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
        { ...caller, idempotencyKey, signal },
        destination,
      ),
    );
  }

  @Route(routes.appendVersion)
  public append(
    @Req() request: ConnectionRequest,
    @In()
    { params, body, idempotencyKey }: RouteInput<typeof routes.appendVersion>,
  ) {
    return this.services.append({
      ...context(request, params),
      idempotencyKey,
      destinationId: params.destinationId,
      body,
    });
  }

  @Route(routes.setStatus)
  public status(
    @Req() request: ConnectionRequest,
    @In()
    { params, body, idempotencyKey }: RouteInput<typeof routes.setStatus>,
  ) {
    return this.services.status({
      ...context(request, params),
      idempotencyKey,
      destinationId: params.destinationId,
      body,
    });
  }

  @Route(routes.policy)
  public getPolicy(
    @Req() request: ConnectionRequest,
    @In() { params }: RouteInput<typeof routes.policy>,
  ) {
    return this.services.getPolicy({
      ...context(request, params),
      workflowId: params.workflowId,
    });
  }

  @Route(routes.setPolicy)
  public async setPolicy(
    @Req() request: ConnectionRequest,
    @In()
    { params, body, idempotencyKey }: RouteInput<typeof routes.setPolicy>,
  ) {
    await this.services.setPolicy({
      ...context(request, params),
      idempotencyKey,
      workflowId: params.workflowId,
      body,
    });
  }

  @Route(routes.clearPolicy)
  public async clearPolicy(
    @Req() request: ConnectionRequest,
    @In() { params, idempotencyKey }: RouteInput<typeof routes.clearPolicy>,
  ) {
    await this.services.clearPolicy({
      ...context(request, params),
      idempotencyKey,
      workflowId: params.workflowId,
    });
  }
}
