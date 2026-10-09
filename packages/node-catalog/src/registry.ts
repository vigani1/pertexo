import {
  EMAIL_SEND_NOTIFICATION_MANIFEST,
  EMAIL_SEND_NOTIFICATION_POLICY,
  HTTP_REQUEST_MANIFEST,
  HTTP_REQUEST_NETWORK_POLICY,
  HTTP_REQUEST_VALUE_POLICY,
  SLACK_SEND_MESSAGE_MANIFEST,
  SLACK_SEND_MESSAGE_POLICY,
} from '@pertexo/integrations';
import { createNodeCatalog, executorManifestFor } from '@pertexo/node-sdk';
import { CORE_NODE_CATALOG } from '@pertexo/nodes-core';

const INTEGRATION_MANIFESTS = [
  HTTP_REQUEST_MANIFEST,
  SLACK_SEND_MESSAGE_MANIFEST,
  EMAIL_SEND_NOTIFICATION_MANIFEST,
];

/** The one catalog every API and worker serves: core nodes and integrations. */
export const PLATFORM_NODE_CATALOG = createNodeCatalog({
  definitions: [...CORE_NODE_CATALOG.definitions, ...INTEGRATION_MANIFESTS],
  executors: [
    ...CORE_NODE_CATALOG.executors,
    ...INTEGRATION_MANIFESTS.map(executorManifestFor),
  ],
  policies: [
    ...CORE_NODE_CATALOG.policies,
    HTTP_REQUEST_NETWORK_POLICY,
    HTTP_REQUEST_VALUE_POLICY,
    SLACK_SEND_MESSAGE_POLICY,
    EMAIL_SEND_NOTIFICATION_POLICY,
  ],
});
