import type { IdentityWorkspaceRequest } from '../workspaces/workspace-transport.js';

export {
  connectionListResponseSchema,
  connectionResponseSchema,
  connectionTestRequestSchema,
  connectionTestResponseSchema,
  slackBotTokenCredentialSchema,
  type ConnectionResponse,
  type ConnectionListResponse,
  type ConnectionTestResponse,
} from '@pertexo/contracts';

export type ConnectionRequest = IdentityWorkspaceRequest &
  Readonly<{
    raw?: Readonly<{
      destroyed?: boolean;
      once(event: 'aborted', listener: () => void): unknown;
      off(event: 'aborted', listener: () => void): unknown;
    }>;
  }>;
