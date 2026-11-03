import type { IdentityWorkspaceRequest } from '../workspaces/types.js';

export {
  connectionCreateRequestSchema,
  connectionListResponseSchema,
  connectionResponseSchema,
  connectionRotateSecretRequestSchema,
  connectionTestRequestSchema,
  connectionTestResponseSchema,
  signingKeyCredentialSchema,
  httpHeadersCredentialSchema,
  slackBotTokenCredentialSchema,
  slackChannelLookupResponseSchema,
  resendApiKeyCredentialSchema,
  type ConnectionResponse,
  type ConnectionListResponse,
  type ConnectionTestResponse,
  type SlackChannelLookupItem,
  type SlackChannelLookupResponse,
  type SlackChannelUnresolvedReason,
} from '@pertexo/contracts';

export type ConnectionRequest = IdentityWorkspaceRequest &
  Readonly<{
    raw?: Readonly<{
      destroyed?: boolean;
      once(event: 'aborted', listener: () => void): unknown;
      off(event: 'aborted', listener: () => void): unknown;
    }>;
  }>;
