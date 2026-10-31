export const OAUTH2_STAND_IN_RESPONSE_LIMIT_BYTES: number;
export const OAUTH2_STAND_IN_RETRY_AFTER_SECONDS: number;
export const OAUTH2_STAND_IN_PAGES: number;
export const OAUTH2_STAND_IN_DESCRIPTION: string;

export interface OAuth2StandInRequest {
  at: number;
  method: string;
  path: string;
  query: Record<string, string>;
  headers: Record<string, string | string[] | undefined>;
  host: string | undefined;
  body: string;
  clientId?: string;
  authentication?: {
    method: 'basic' | 'body';
    clientId: string;
    clientSecret: string;
  };
  form?: Record<string, string>;
  issued?: { accessToken?: string; refreshToken?: string };
}

export type OAuth2StandInHold = Readonly<{
  arrived: Promise<void>;
  release: () => void;
}>;

export type OAuth2StandIn = Readonly<{
  origin: string;
  requests: readonly OAuth2StandInRequest[];
  tokenRequests: (clientId: string) => readonly OAuth2StandInRequest[];
  apiCalls: (clientId: string) => readonly OAuth2StandInRequest[];
  redirectTargetRequests: () => readonly OAuth2StandInRequest[];
  authorizeRequests: (clientId: string) => readonly OAuth2StandInRequest[];
  expectSecret: (clientId: string, secret: string) => void;
  setBehavior: (clientId: string, behavior: string) => void;
  setExpiresIn: (clientId: string, seconds: number) => void;
  setRetryAfter: (clientId: string, seconds: number) => void;
  acceptAnyRefresh: (clientId: string) => void;
  scriptAnswers: (clientId: string, behaviors: readonly string[]) => void;
  holdNextToken: (clientId: string) => OAuth2StandInHold;
  revoke: (clientId: string) => void;
  newClient: (behavior: string) => string;
  close: () => Promise<void>;
}>;

export function startOAuth2StandIn(options?: {
  host?: string;
  port?: number;
}): Promise<OAuth2StandIn>;
