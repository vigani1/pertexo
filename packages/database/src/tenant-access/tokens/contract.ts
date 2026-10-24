import type {
  ApiTokenCreateRequest,
  ApiTokenCreateResponse,
  ApiTokenMetadata,
  ApiTokenRevokeResponse,
  ApiTokenScope,
} from '@pertexo/contracts';
import type { ParsedApiTokenCredential } from './credential.js';

export type ApiTokenOwner = Readonly<{
  workspaceId: string;
  ownerUserId: string;
  signal?: AbortSignal;
}>;
export type ApiTokenCommand = ApiTokenOwner &
  Readonly<{ idempotencyKey: string; requestId?: string; traceId?: string }>;
export type VerifiedApiToken = Readonly<{
  workspaceId: string;
  ownerUserId: string;
  tokenId: string;
  scopes: readonly ApiTokenScope[];
}>;
export interface ApiTokenDatabase {
  create(
    input: ApiTokenCommand & ApiTokenCreateRequest,
  ): Promise<ApiTokenCreateResponse>;
  list(input: ApiTokenOwner & { limit: number; after?: string }): Promise<{
    items: ApiTokenMetadata[];
    nextCursor: string | null;
    availableScopes: ApiTokenScope[];
  }>;
  revoke(
    input: ApiTokenCommand & { tokenId: string },
  ): Promise<ApiTokenRevokeResponse>;
  authenticate(
    input: ParsedApiTokenCredential,
    signal?: AbortSignal,
  ): Promise<VerifiedApiToken | undefined>;
  close(): Promise<void>;
}
