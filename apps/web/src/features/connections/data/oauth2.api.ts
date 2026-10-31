import {
  oauth2AuthorizationStartResponseSchema,
  type OAuth2AuthorizationStartResponse,
} from '@pertexo/contracts';
import type { ApiClient } from '@/lib/api/client';

/** A server-to-server connection answers `connected` at once; the rest need consent. */
export function startOAuth2Authorization(
  apiClient: ApiClient,
  workspaceId: string,
  connectionId: string,
): Promise<OAuth2AuthorizationStartResponse> {
  return apiClient.request({
    path: `/v1/workspaces/${encodeURIComponent(workspaceId)}/connections/${encodeURIComponent(connectionId)}/oauth2/authorization`,
    method: 'POST',
    response: {
      kind: 'json',
      decode: (value) => oauth2AuthorizationStartResponseSchema.parse(value),
    },
  });
}
