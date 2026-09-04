import { z } from 'zod';
import type { IdentityWorkspaceRequest } from '../identity-workspace/types.js';

export {
  connectionCreateRequestSchema,
  connectionIdParamSchema,
  connectionResponseSchema,
  connectionRotateSecretRequestSchema,
  connectionTestRequestSchema,
  connectionTestResponseSchema,
  httpHeadersCredentialSchema,
  slackBotTokenCredentialSchema,
  resendApiKeyCredentialSchema,
  type ConnectionResponse,
  type ConnectionTestResponse,
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
