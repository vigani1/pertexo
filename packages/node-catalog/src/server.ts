import type { DefinitionIdentity } from '@pertexo/node-sdk';
export { validateRegisteredCuratedTemplateSetup } from './curated-template-policy.js';
export { platformPortableDefinitionPolicy } from './portable-definition-policy.js';

import type { IntegrationExecutorDependencies } from '@pertexo/integrations/server';
import {
  admitNodeExecutionInput,
  NodeInputValidationError,
  type JsonValue,
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
import {
  installPlatformIntegrations,
  platformRegistry,
  resolvePlatformNodeDefinition,
} from './catalog.js';
import type { CommunityApprovalSet } from './community/approvals.js';
import {
  loadCommunityModules,
  loadAuthorCommunityModule,
} from './community/load-community-modules.js';

export {
  communityApprovalDigest,
  parseCommunityApprovalSet,
  type CommunityApprovalSet,
} from './community/approvals.js';

export async function loadPlatformRegistry(
  approved?: CommunityApprovalSet,
  onVerifiedFile?: Parameters<typeof loadCommunityModules>[1],
): Promise<void> {
  installPlatformIntegrations(
    approved === undefined
      ? undefined
      : await loadCommunityModules(approved, onVerifiedFile),
  );
}

export function admitPlatformNodeInput(
  definition: DefinitionIdentity,
  input: JsonValue,
) {
  const { inputSchema } = resolvePlatformNodeDefinition(definition);
  try {
    return admitNodeExecutionInput(inputSchema, input);
  } catch (error) {
    if (error instanceof NodeInputValidationError) return undefined;
    throw error;
  }
}

export type PlatformNodeRegistryDependencies = IntegrationExecutorDependencies;

/** The executing registry for the platform catalog; provider clients can be injected. */
export function createPlatformNodeRegistry(
  dependencies: PlatformNodeRegistryDependencies,
): NodeRegistry {
  const { catalog, integrations } = platformRegistry();
  return createNodeRegistry({
    catalog,
    definitions: integrations.registrations,
    core: {
      definitions: CORE_NODE_DEFINITION_REGISTRATIONS,
      executors: CORE_NODE_EXECUTOR_REGISTRATIONS,
    },
    executors: integrations.createExecutors(dependencies),
  });
}

/** Whether an integration declares this code safe for persisted summaries. */
export function isIntegrationExecutorSummaryCode(code: string): boolean {
  return platformRegistry().integrations.acceptsExecutorSummary(code);
}

/** Resolve the polling adapter for a pinned trigger definition. */
export function resolvePlatformPollFetcher(definition: {
  key: string;
  version: number;
}) {
  const fetchPoll = platformRegistry().integrations.pollFetcherFor(definition);
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

/** CLI-only. Check the author's exact bytes against the same registry used at startup. */
export async function loadAuthorCommunityRelease(root: string, file: string) {
  const release = await loadAuthorCommunityModule(root, file);
  installPlatformIntegrations([release.module]);
  return release;
}
