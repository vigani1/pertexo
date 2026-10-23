import { createErrorRegistry } from '../platform/http/problems/registry.js';
import {
  applicationError,
  isApplicationError,
  type ApplicationError,
} from '../platform/http/application-error.js';
import { workflowProblems } from './authoring/workflows.js';
import { identityProblems } from './identity/workspaces.js';
import { connectionProblems } from './resources/connections.js';
import { artifactProblems } from './resources/artifacts.js';
import { nodeTestProblems } from './authoring/tests.js';
import { runProblems } from './authoring/runs.js';
import { organizationProblems } from './authoring/organization.js';
import { portabilityProblems } from './authoring/portability.js';
import { dataTableProblems } from './resources/tables.js';
import { inboxProblems } from './resources/notifications.js';
import { contextualProblems } from './context/projections.js';

import { formsProblems } from './workspace/forms.js';
import { tasksProblems } from './workspace/tasks.js';
import { governanceProblems } from './workspace/governance.js';
import { variablesProblems } from './workspace/variables.js';
import { preferencesProblems } from './workspace/preferences.js';
import { federationProblems } from './identity/federation.js';
import { directoryProblems } from './identity/directory.js';
import { collaborationProblems } from './authoring/collaboration.js';
import { webhookTestsProblems } from './workspace/webhook-tests.js';
import { webhooksProblems } from './workspace/webhooks.js';
import { schedulesProblems } from './workspace/schedules.js';
import { tokensProblems } from './resources/tokens.js';

const errorRegistry = createErrorRegistry([
  ...contextualProblems,
  ...formsProblems,
  ...tasksProblems,
  ...governanceProblems,
  ...variablesProblems,
  ...preferencesProblems,
  ...federationProblems,
  ...directoryProblems,
  ...collaborationProblems,
  ...webhookTestsProblems,
  ...webhooksProblems,
  ...schedulesProblems,
  ...tokensProblems,
  ...workflowProblems,
  ...identityProblems,
  ...connectionProblems,
  ...artifactProblems,
  ...nodeTestProblems,
  ...runProblems,
  ...organizationProblems,
  ...portabilityProblems,
  ...dataTableProblems,
  ...inboxProblems,
]);

export function toProblem(error: unknown): ApplicationError {
  const registered = errorRegistry(error);
  if (registered !== undefined) return registered;
  if (isApplicationError(error)) return error;
  return applicationError('internal.unexpected', { cause: error });
}
