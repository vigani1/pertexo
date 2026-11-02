import type {
  ApiTokenCreateRequest,
  ApiTokenMetadata,
  ApiTokenScope,
} from '@pertexo/contracts';

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
export type ListApiTokensInput = ApiTokenOwner &
  Readonly<{ limit: number; after?: string }>;
export type ApiTokensPage = Readonly<{
  items: ApiTokenMetadata[];
  nextCursor: string | null;
  availableScopes: ApiTokenScope[];
}>;
export type CreateApiTokenInput = ApiTokenCommand & ApiTokenCreateRequest;
export type RevokeApiTokenInput = ApiTokenCommand &
  Readonly<{ tokenId: string }>;
