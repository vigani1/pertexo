export { validateRegisteredCuratedTemplateSetup } from './curated-template-policy.js';
export { platformPortableDefinitionPolicy } from './portable-definition-policy.js';

import type { IntegrationExecutorDependencies } from '@pertexo/integrations/server';
import {
  createNodeRegistry,
  createInlineNodeRegistry,
  type InlineNodeRegistry,
  type NodeRegistry,
} from '@pertexo/node-sdk/server';
import {
  CORE_NODE_CATALOG,
  CORE_NODE_DEFINITION_REGISTRATIONS,
} from '@pertexo/nodes-core';
import { CORE_NODE_EXECUTOR_REGISTRATIONS } from '@pertexo/nodes-core/server';
import { PlatformNodeDefinitionUnavailableError } from './node-catalog.errors.js';
import { PLATFORM_NODE_CATALOG } from './catalog.js';
import { INTEGRATION_MODULE_REGISTRY } from './integration-modules.js';

export type PlatformNodeRegistryDependencies = IntegrationExecutorDependencies;

/** The executing registry for the platform catalog; provider clients can be injected. */
export function createPlatformNodeRegistry(
  dependencies: PlatformNodeRegistryDependencies,
): NodeRegistry {
  return createNodeRegistry({
    catalog: PLATFORM_NODE_CATALOG,
    definitions: INTEGRATION_MODULE_REGISTRY.registrations,
    core: {
      definitions: CORE_NODE_DEFINITION_REGISTRATIONS,
      executors: CORE_NODE_EXECUTOR_REGISTRATIONS,
    },
    executors: INTEGRATION_MODULE_REGISTRY.createExecutors(dependencies),
  });
}

/** Whether an integration declares this code safe for persisted summaries. */
export const isIntegrationExecutorSummaryCode =
  INTEGRATION_MODULE_REGISTRY.acceptsExecutorSummary;

/** Resolve the polling adapter for a pinned trigger definition. */
export function resolvePlatformPollFetcher(definition: {
  key: string;
  version: number;
}) {
  const fetchPoll = INTEGRATION_MODULE_REGISTRY.pollFetcherFor(definition);
  if (fetchPoll === undefined)
    throw new PlatformNodeDefinitionUnavailableError();
  return fetchPoll;
}

/** The coordinator can run trusted kernels without constructing provider clients. */
export function createPlatformInlineRegistry(): InlineNodeRegistry {
  return createInlineNodeRegistry({
    catalog: CORE_NODE_CATALOG,
    definitions: [],
    executors: [],
    core: {
      definitions: CORE_NODE_DEFINITION_REGISTRATIONS,
      executors: CORE_NODE_EXECUTOR_REGISTRATIONS,
    },
  });
}
