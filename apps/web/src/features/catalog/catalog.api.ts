import {
  integrationListResponseSchema,
  nodeDefinitionListResponseSchema,
} from '@pertexo/contracts/schemas/catalog';
import type { ApiClient } from '@/lib/api/client';

export async function getAuthoringCatalog(
  apiClient: ApiClient,
  signal?: AbortSignal,
) {
  const requestOptions = signal === undefined ? {} : { signal };
  const [definitions, integrations] = await Promise.all([
    apiClient.request({
      path: '/v1/node-definitions',
      ...requestOptions,
      response: {
        kind: 'json',
        decode: (value) => nodeDefinitionListResponseSchema.parse(value),
      },
    }),
    apiClient.request({
      path: '/v1/integrations',
      ...requestOptions,
      response: {
        kind: 'json',
        decode: (value) => integrationListResponseSchema.parse(value),
      },
    }),
  ]);
  return Object.freeze({ definitions, integrations });
}
