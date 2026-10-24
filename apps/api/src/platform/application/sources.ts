import type { ApiConfig } from '../config/api.js';
import type {
  ApiConnectionRuntime,
  ApiConnectionRuntimeOverrides,
} from '../connections/runtime.module.js';
import type {
  ApiIdentityRuntime,
  ApiIdentityRuntimeOverrides,
} from '../identity/runtime.module.js';
import type {
  ApiWorkflowRuntime,
  ApiWorkflowRuntimeOverrides,
} from '../workflow/runtime.module.js';

import type {
  ApiArtifactRuntime,
  ApiArtifactRuntimeOverrides,
} from '../artifacts/runtime.module.js';
import type {
  ApiApplicationDependencyCore,
  ApiApplicationDependencies,
} from './contract.js';

export function assertValidRuntimeSources(
  config: ApiConfig,
  dependencies: ApiApplicationDependencies,
): void {
  const unchecked = dependencies as ApiApplicationDependencyCore & {
    identityRuntime?: ApiIdentityRuntime;
    identityOverrides?: ApiIdentityRuntimeOverrides;
    connectionRuntime?: ApiConnectionRuntime;
    connectionOverrides?: ApiConnectionRuntimeOverrides;
    workflowRuntime?: ApiWorkflowRuntime;
    workflowOverrides?: ApiWorkflowRuntimeOverrides;
    artifactRuntime?: ApiArtifactRuntime;
    artifactOverrides?: ApiArtifactRuntimeOverrides;
  };
  assertExclusiveRuntime(
    'identity',
    unchecked.identityRuntime,
    unchecked.identityOverrides,
  );
  assertExclusiveRuntime(
    'artifact',
    unchecked.artifactRuntime,
    unchecked.artifactOverrides,
  );
  assertExclusiveRuntime(
    'connection',
    unchecked.connectionRuntime,
    unchecked.connectionOverrides,
  );
  assertExclusiveRuntime(
    'workflow',
    unchecked.workflowRuntime,
    unchecked.workflowOverrides,
  );

  const identityAvailable =
    unchecked.identityRuntime !== undefined || config.identity !== undefined;
  if (
    unchecked.identityOverrides !== undefined &&
    config.identity === undefined
  )
    throw new TypeError(
      'identity overrides require configured identity runtime creation',
    );
  if (
    unchecked.connectionOverrides !== undefined &&
    (config.connections === undefined || !identityAvailable)
  )
    throw new TypeError(
      'connection overrides require configured connection runtime creation',
    );
  if (unchecked.workflowOverrides !== undefined && !identityAvailable)
    throw new TypeError(
      'workflow overrides require available identity runtime creation',
    );
  if (
    unchecked.artifactOverrides !== undefined &&
    (config.artifacts === undefined || !identityAvailable)
  )
    throw new TypeError(
      'artifact overrides require configured artifact runtime creation',
    );
  if (!identityAvailable) {
    const featureRuntimeAvailable =
      unchecked.connectionRuntime !== undefined ||
      unchecked.workflowRuntime !== undefined ||
      unchecked.webhookRuntime !== undefined ||
      unchecked.scheduleRuntime !== undefined ||
      unchecked.notificationRuntime !== undefined ||
      unchecked.artifactRuntime !== undefined;
    if (featureRuntimeAvailable)
      throw new TypeError(
        'feature runtimes require an available identity runtime',
      );
  }
}

function assertExclusiveRuntime(
  feature: string,
  runtime: unknown,
  overrides: unknown,
): void {
  if (runtime !== undefined && overrides !== undefined)
    throw new TypeError(
      `${feature} runtime cannot be provided with ${feature} overrides`,
    );
}
