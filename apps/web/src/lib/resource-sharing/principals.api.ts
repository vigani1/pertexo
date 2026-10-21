import {
  sharingPrincipalsResponseSchema,
  type SharingPrincipalsQuery,
} from '@pertexo/contracts';
import type { ApiClient } from '../api/client';
export function readSharingPrincipals(
  api: ApiClient,
  workspaceId: string,
  input: SharingPrincipalsQuery,
  signal: AbortSignal,
) {
  const params = new URLSearchParams({
    kind: input.kind,
    limit: String(input.limit),
  });
  if (input.search) params.set('search', input.search);
  if (input.after) params.set('after', input.after);
  return api.request({
    path: `/v1/workspaces/${encodeURIComponent(workspaceId)}/resource-sharing-principals?${params}`,
    signal,
    response: {
      kind: 'json',
      decode: (value) => sharingPrincipalsResponseSchema.parse(value),
    },
  });
}
