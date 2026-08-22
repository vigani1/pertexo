import { z } from 'zod';

export {
  connectionCreateRequestSchema,
  connectionIdParamSchema,
  connectionResponseSchema,
  connectionRotateSecretRequestSchema,
  type ConnectionResponse,
  type ParsedConnectionCreateRequest,
  type ParsedConnectionRotateSecretRequest,
} from '@pertexo/contracts/connections';

export const connectionWorkspaceParamSchema = z
  .object({ workspaceId: z.uuid() })
  .strict()
  .readonly();

export type { IdentityWorkspaceRequest as ConnectionRequest } from '../identity-workspace/types.js';
