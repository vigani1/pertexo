import { generateSchemaDocument, type NodeManifest } from '@pertexo/node-sdk';

import {
  httpRequestConfigSchema,
  httpRequestInputSchema,
  httpRequestOutputSchema,
} from './validation.js';

export const HTTP_REQUEST_DEFINITION = Object.freeze({
  key: 'http.request',
  version: 1,
});
export const HTTP_REQUEST_EXECUTOR = Object.freeze({
  key: 'http.request',
  version: 1,
});
export const HTTP_REQUEST_CONNECTION_SLOT = 'http_headers' as const;
export const HTTP_REQUEST_NETWORK_POLICY = Object.freeze({
  key: 'http.network',
  version: 1,
});
export const HTTP_REQUEST_VALUE_POLICY = Object.freeze({
  key: 'http.response.value',
  version: 1,
});

export const HTTP_REQUEST_MANIFEST: NodeManifest = Object.freeze({
  schemaVersion: 1,
  definition: HTTP_REQUEST_DEFINITION,
  family: 'action',
  configVersion: 1,
  configSchema: generateSchemaDocument(httpRequestConfigSchema),
  inputSchema: generateSchemaDocument(httpRequestInputSchema),
  outputSchema: generateSchemaDocument(httpRequestOutputSchema),
  ports: Object.freeze({
    inputs: Object.freeze(['in']),
    outputs: Object.freeze(['out']),
  }),
  credentialRequirements: Object.freeze([HTTP_REQUEST_CONNECTION_SLOT]),
  connectionRequirements: Object.freeze([HTTP_REQUEST_CONNECTION_SLOT]),
  retryClass: 'unsafe',
  resourceClass: 'io',
  capabilities: Object.freeze([
    'external_http',
    'artifact_output',
    'side_effect_disclosure',
  ]),
  lifecycle: 'active',
  executor: HTTP_REQUEST_EXECUTOR,
  executorAbi: 2,
  policyReferences: Object.freeze([
    HTTP_REQUEST_NETWORK_POLICY,
    HTTP_REQUEST_VALUE_POLICY,
  ]),
});

export const HTTP_REQUEST_DEFINITION_REGISTRATION = Object.freeze({
  manifest: HTTP_REQUEST_MANIFEST,
  configSchema: httpRequestConfigSchema,
  inputSchema: httpRequestInputSchema,
  outputSchema: httpRequestOutputSchema,
});
