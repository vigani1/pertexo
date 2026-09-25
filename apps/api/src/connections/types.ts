import { z } from 'zod';
import type { IdentityWorkspaceRequest } from '../identity-workspace/types.js';

export {
  connectionCreateRequestSchema,
  connectionIdParamSchema,
  connectionListQuerySchema,
  connectionListResponseSchema,
  connectionResponseSchema,
  connectionRotateSecretRequestSchema,
  connectionTestRequestSchema,
  connectionTestResponseSchema,
  httpHeadersCredentialSchema,
  slackBotTokenCredentialSchema,
  slackChannelLookupQuerySchema,
  slackChannelLookupResponseSchema,
  resendApiKeyCredentialSchema,
  type ConnectionResponse,
  type ConnectionListResponse,
  type ConnectionTestResponse,
  type SlackChannelLookupItem,
  type SlackChannelLookupResponse,
  type SlackChannelUnresolvedReason,
} from '@pertexo/contracts/connections';

export const connectionWorkspaceParamSchema = z
  .object({ workspaceId: z.uuid() })
  .strict()
  .readonly();

export type ConnectionRequest = IdentityWorkspaceRequest &
  Readonly<{
    raw?: Readonly<{
      destroyed?: boolean;
      once(event: 'aborted', listener: () => void): unknown;
      off(event: 'aborted', listener: () => void): unknown;
    }>;
  }>;
