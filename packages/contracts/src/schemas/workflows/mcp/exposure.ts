import { z } from 'zod';
import { storageTextSchema } from '@pertexo/workflow-model';
import { responseSchema } from '../../shared/response-schema.js';

export const MCP_STATUS_TOOL_NAME = 'pertexo.invocation_status';
export const MCP_PROTOCOL_VERSION = '2025-11-25';
export const MCP_ENDPOINT_PATH = '/v1/workspaces/{workspaceId}/mcp';

export const MCP_TOOL_LIMITS = Object.freeze({
  nameCharacters: 128,
  descriptionCharacters: 1024,
});
export const mcpToolNameSchema = storageTextSchema
  .min(1)
  .max(MCP_TOOL_LIMITS.nameCharacters)
  .regex(/^[A-Za-z0-9_.-]+$/u);
const metadata = {
  name: mcpToolNameSchema.refine((name) => name !== MCP_STATUS_TOOL_NAME),
  description: storageTextSchema
    .trim()
    .min(1)
    .max(MCP_TOOL_LIMITS.descriptionCharacters),
};
const exposure = z
  .object({
    ...metadata,
    revision: z.uuid(),
    versionId: z.uuid(),
    entryId: z.string(),
  })
  .strict()
  .nullable();
const expected = {
  expectedVersionId: z.uuid().nullable(),
  expectedRevision: z.uuid().nullable(),
};
export const workflowMcpExposureRequestSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('expose'), ...expected, ...metadata }).strict(),
  z.object({ kind: z.literal('unexpose'), ...expected }).strict(),
]);
export const workflowMcpExposureResponseSchema = responseSchema(
  z
    .object({
      exposure,
    })
    .strict(),
);
export const workflowMcpSettingsSchema = responseSchema(
  z
    .object({
      publishedVersionId: z.uuid().nullable(),
      eligible: z.boolean(),
      exposure,
    })
    .strict(),
);
export type WorkflowMcpExposureRequest = z.output<
  typeof workflowMcpExposureRequestSchema
>;
export type WorkflowMcpSettings = z.output<typeof workflowMcpSettingsSchema>;
