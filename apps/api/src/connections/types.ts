import { z } from 'zod';

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
  type ParsedConnectionCreateRequest,
  type ParsedConnectionRotateSecretRequest,
  type ConnectionTestResponse,
  type ParsedConnectionTestRequest,
} from '@pertexo/contracts/connections';

export const connectionWorkspaceParamSchema = z
  .object({ workspaceId: z.uuid() })
  .strict()
  .readonly();

export type { IdentityWorkspaceRequest as ConnectionRequest } from '../identity-workspace/types.js';
