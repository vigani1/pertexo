import {
  apiTokenCreateRequestSchema,
  apiTokenCreateResponseSchema,
  apiTokenListQuerySchema,
  apiTokenListResponseSchema,
  apiTokenRevokeRequestSchema,
  apiTokenRevokeResponseSchema,
  type ApiTokenListResponse,
} from '@pertexo/contracts';
import type {
  ApiTokenStore,
  ApiTokenOwner,
  ApiTokenCommand,
} from '@pertexo/core/tenant-access';
import { assertRecentSignIn, type IdentityClock } from '../identity/index.js';
import {
  applicationError,
  throwApplicationError,
} from '../platform/http/index.js';
import { parseRequestInput } from '../platform/http/request-input.js';

export class ApiTokenManagement {
  private readonly enabled: boolean;
  private readonly clock: IdentityClock;
  public constructor(
    private readonly database: ApiTokenStore,
    { enabled, clock }: Readonly<{ enabled: boolean; clock: IdentityClock }>,
  ) {
    this.enabled = enabled;
    this.clock = clock;
  }
  public async list(
    input: ApiTokenOwner & { query: unknown },
  ): Promise<ApiTokenListResponse> {
    const query = parseRequestInput(apiTokenListQuerySchema, input.query);
    return apiTokenListResponseSchema.parse({
      ...(await this.database.list({
        ...input,
        limit: query.limit,
        ...(query.after === undefined ? {} : { after: query.after }),
      })),
      enabled: this.enabled,
    });
  }
  public async create(
    input: ApiTokenCommand & { request: unknown; signedInAt: Date },
  ) {
    if (!this.enabled)
      return throwApplicationError(
        applicationError('api_token.unavailable', {
          safeDetail: 'Automation tokens are disabled on this server.',
        }),
      );
    const request = parseRequestInput(
      apiTokenCreateRequestSchema,
      input.request,
    );
    assertRecentSignIn(input.signedInAt, this.clock.now());
    return apiTokenCreateResponseSchema.parse(
      await this.database.create({ ...input, ...request }),
    );
  }
  public async revoke(
    input: ApiTokenCommand & { tokenId: string; request: unknown },
  ) {
    parseRequestInput(apiTokenRevokeRequestSchema, input.request);
    return apiTokenRevokeResponseSchema.parse(
      await this.database.revoke(input),
    );
  }
}
