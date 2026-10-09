import {
  HTTP_REQUEST_MANIFEST,
  HTTP_REQUEST_NETWORK_POLICY,
  HTTP_REQUEST_VALUE_POLICY,
  SLACK_SEND_MESSAGE_MANIFEST,
  SLACK_SEND_MESSAGE_POLICY,
  EMAIL_SEND_NOTIFICATION_MANIFEST,
  EMAIL_SEND_NOTIFICATION_POLICY,
} from '@pertexo/integrations';
import {
  createRegistryRelease,
  type ExecutorManifest,
  type NodeManifest,
} from '@pertexo/node-sdk';
import {
  CORE_CONDITION_MANIFEST,
  CORE_FOR_EACH_MANIFEST,
  CORE_MERGE_MANIFEST,
  CORE_MERGE_MANIFEST_V2,
  CORE_MERGE_MANIFEST_V3,
  CORE_PARALLEL_MANIFEST,
  CORE_PARALLEL_MANIFEST_V2,
  CORE_PARALLEL_MANIFEST_V3,
  CORE_REGISTRY_RELEASE,
  CORE_SCHEDULE_MANIFEST,
  CORE_SCHEDULE_MANIFEST_V2,
  CORE_SCHEDULE_MANIFEST_V3,
  CORE_SWITCH_MANIFEST,
  CORE_VALIDATE_MANIFEST,
  CORE_WAIT_MANIFEST,
  CORE_WEBHOOK_MANIFEST,
} from '@pertexo/nodes-core';

/** Every node beyond the three in the core release. */
const PLATFORM_MANIFESTS: readonly NodeManifest[] = [
  HTTP_REQUEST_MANIFEST,
  CORE_CONDITION_MANIFEST,
  CORE_SWITCH_MANIFEST,
  CORE_PARALLEL_MANIFEST,
  CORE_PARALLEL_MANIFEST_V2,
  CORE_PARALLEL_MANIFEST_V3,
  CORE_MERGE_MANIFEST,
  CORE_MERGE_MANIFEST_V2,
  CORE_MERGE_MANIFEST_V3,
  CORE_FOR_EACH_MANIFEST,
  CORE_WAIT_MANIFEST,
  SLACK_SEND_MESSAGE_MANIFEST,
  EMAIL_SEND_NOTIFICATION_MANIFEST,
  CORE_WEBHOOK_MANIFEST,
  CORE_SCHEDULE_MANIFEST,
  CORE_SCHEDULE_MANIFEST_V2,
  CORE_SCHEDULE_MANIFEST_V3,
  CORE_VALIDATE_MANIFEST,
];

function executorFor(manifest: NodeManifest): ExecutorManifest {
  if (manifest.executorAbi === undefined)
    throw new Error(
      `${manifest.definition.key} manifest must pin its executor ABI`,
    );
  return {
    executor: manifest.executor,
    abiVersion: manifest.executorAbi,
    definitions: [manifest.definition],
    lifecycle: 'active',
    policyReferences: manifest.policyReferences,
  };
}

/** The one catalog every API and worker serves: every node, all active. */
export const PLATFORM_REGISTRY_RELEASE = createRegistryRelease({
  epoch: 1,
  definitions: [...CORE_REGISTRY_RELEASE.definitions, ...PLATFORM_MANIFESTS],
  executors: [
    ...CORE_REGISTRY_RELEASE.executors,
    ...PLATFORM_MANIFESTS.map(executorFor),
  ],
  policies: [
    ...CORE_REGISTRY_RELEASE.policies,
    HTTP_REQUEST_NETWORK_POLICY,
    HTTP_REQUEST_VALUE_POLICY,
    SLACK_SEND_MESSAGE_POLICY,
    EMAIL_SEND_NOTIFICATION_POLICY,
  ],
});
