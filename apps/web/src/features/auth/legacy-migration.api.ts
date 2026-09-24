import {
  legacyMethodMigrationStartResponseSchema,
  type AuthenticationCapabilitiesResponse,
} from '@pertexo/contracts/schemas/identity-workspace';
import type { ApiClient } from '@/lib/api/client';

export async function startLegacyMethodMigration(
  apiClient: ApiClient,
  provider: AuthenticationCapabilitiesResponse['socialProviders'][number],
  signal?: AbortSignal,
): Promise<string> {
  const result = await apiClient.request({
    path: '/v1/auth/legacy-migration/start',
    method: 'POST',
    csrf: 'external',
    body: { provider },
    ...(signal === undefined ? {} : { signal }),
    response: {
      kind: 'json',
      decode: (value) => legacyMethodMigrationStartResponseSchema.parse(value),
    },
  });
  const url = new URL(result.authorizationUrl);
  if (url.protocol !== 'https:' && url.hostname !== 'localhost')
    throw new TypeError('The legacy identity provider URL was rejected.');
  return url.toString();
}
