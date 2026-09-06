import { Reflector } from '@nestjs/core';
import { describe, expect, it } from 'vitest';

import { ConnectionsController } from '../../src/connections/controllers.js';
import { FailureNotificationDestinationsController } from '../../src/connections/failure-notification-destinations.js';
import {
  OidcController,
  SessionController,
  WorkspaceController,
} from '../../src/identity-workspace/controllers.js';
import { NodeTestingController } from '../../src/node-testing/controller.js';
import { LiveController } from '../../src/platform/health/live.controller.js';
import { ReadyController } from '../../src/platform/health/ready.controller.js';
import {
  RATE_LIMIT_EXEMPT,
  RATE_LIMIT_METADATA,
} from '../../src/platform/rate-limit/metadata.js';
import type { RateLimitEndpointClass } from '@pertexo/rate-limit';
import { ScheduleManagementController } from '../../src/schedules/controllers.js';
import { WebhookManagementController } from '../../src/webhooks/controllers.js';
import { WorkflowAuthoringController } from '../../src/workflow-authoring/controllers.js';
import { WorkflowRunsController } from '../../src/workflow-runs/controllers.js';

type ControllerType = abstract new (...arguments_: never[]) => unknown;
type ExpectedClassification = RateLimitEndpointClass | typeof RATE_LIMIT_EXEMPT;

const routes: readonly (readonly [
  ControllerType,
  string,
  ExpectedClassification,
])[] = [
  [OidcController, 'start', 'identity_start'],
  [OidcController, 'callback', 'identity_callback'],
  [SessionController, 'logout', 'actor_mutation'],
  [WorkspaceController, 'create', 'actor_mutation'],
  [WorkspaceController, 'requestDeletion', 'ordinary_mutation'],
  [WorkspaceController, 'restore', 'ordinary_mutation'],
  [WorkspaceController, 'readLifecycleOperation', 'authenticated_read'],
  [ConnectionsController, 'create', 'ordinary_mutation'],
  [ConnectionsController, 'rotate', 'connection_mutation'],
  [ConnectionsController, 'revoke', 'connection_mutation'],
  [ConnectionsController, 'test', 'provider_test'],
  [FailureNotificationDestinationsController, 'create', 'ordinary_mutation'],
  [FailureNotificationDestinationsController, 'list', 'authenticated_read'],
  [FailureNotificationDestinationsController, 'get', 'authenticated_read'],
  [FailureNotificationDestinationsController, 'append', 'ordinary_mutation'],
  [FailureNotificationDestinationsController, 'status', 'ordinary_mutation'],
  [FailureNotificationDestinationsController, 'setPolicy', 'ordinary_mutation'],
  [
    FailureNotificationDestinationsController,
    'clearPolicy',
    'ordinary_mutation',
  ],
  [WorkflowAuthoringController, 'list', 'authenticated_read'],
  [WorkflowAuthoringController, 'create', 'ordinary_mutation'],
  [WorkflowAuthoringController, 'draft', 'authenticated_read'],
  [WorkflowAuthoringController, 'save', 'ordinary_mutation'],
  [WorkflowAuthoringController, 'validate', 'workflow_compile'],
  [WorkflowAuthoringController, 'publish', 'workflow_compile'],
  [WorkflowAuthoringController, 'versions', 'authenticated_read'],
  [WorkflowRunsController, 'startRun', 'run_admission'],
  [WorkflowRunsController, 'replayRun', 'run_admission'],
  [WorkflowRunsController, 'getRun', 'authenticated_read'],
  [WorkflowRunsController, 'streamRunEvents', 'authenticated_read'],
  [WorkflowRunsController, 'cancelRun', 'ordinary_mutation'],
  [NodeTestingController, 'status', 'authenticated_read'],
  [NodeTestingController, 'test', 'preview_test'],
  [WebhookManagementController, 'list', 'authenticated_read'],
  [WebhookManagementController, 'provision', 'trigger_mutation'],
  [WebhookManagementController, 'rotateEndpoint', 'trigger_mutation'],
  [WebhookManagementController, 'rotateSecret', 'trigger_mutation'],
  [ScheduleManagementController, 'list', 'authenticated_read'],
  [ScheduleManagementController, 'enable', 'trigger_mutation'],
  [ScheduleManagementController, 'disable', 'trigger_mutation'],
  [LiveController, 'live', RATE_LIMIT_EXEMPT],
  [ReadyController, 'ready', RATE_LIMIT_EXEMPT],
];

describe('HTTP rate-limit classification contract', () => {
  const reflector = new Reflector();

  it.each(routes)(
    '%s.%s is explicitly classified',
    (controller, method, expected) => {
      // TypeScript declares PropertyDescriptor.value as any; the runtime assertion
      // immediately below closes that reflection boundary.
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      const handler = Object.getOwnPropertyDescriptor(
        controller.prototype,
        method,
      )?.value;
      expect(handler).toBeTypeOf('function');
      expect(
        // Nest's Reflector target type uses any internally.
        // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
        reflector.getAllAndOverride(RATE_LIMIT_METADATA, [handler, controller]),
      ).toBe(expected);
    },
  );
});
