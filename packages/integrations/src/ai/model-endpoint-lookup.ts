import { z } from 'zod';
import { defineConnectionLookup } from '../providers/connection-lookup.js';
import {
  MODEL_AUTH_TYPE,
  MODEL_ENDPOINT_LOOKUP,
  modelCredentialSchema,
  modelEndpointHost,
} from './connections.definition.js';

export const modelEndpointLookup = defineConnectionLookup({
  key: MODEL_ENDPOINT_LOOKUP,
  authType: MODEL_AUTH_TYPE,
  inputSchema: z.undefined(),
  credentialSchema: modelCredentialSchema,
  discover(_input, credential) {
    const host = modelEndpointHost(credential);
    return Promise.resolve({
      items: [{ value: 'host', label: 'host', attach: host }],
    });
  },
});
