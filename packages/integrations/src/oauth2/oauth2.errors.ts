import type {
  OAuth2ServiceError,
  OAuth2StepFailureCode,
} from '@pertexo/contracts';

/** Why a step or a connection test has no token. Each code has one meaning. */
export class OAuth2TokenFailure extends Error {
  public override readonly name = 'OAuth2TokenFailure';
  public constructor(
    public readonly code: OAuth2StepFailureCode,
    public readonly retryAfterSeconds?: number,
    public readonly serviceError?: OAuth2ServiceError,
  ) {
    super(`OAuth2 token unavailable: ${code}`);
  }
}
