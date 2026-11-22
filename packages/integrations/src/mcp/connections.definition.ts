import { CONNECTION_CREDENTIALS_BOUNDS } from '@pertexo/contracts';
import { z } from 'zod';
import type { ConnectionDefinition } from '../providers/connection-definition.js';
import { MCP_LIMITS } from './mcp-limits.js';

export const MCP_PROVIDER_KEY = 'mcp';
export const MCP_AUTH_TYPE = 'mcp_bearer';
export const MCP_TOOLS_LOOKUP = 'tools';

const endpoint = z
  .url({ protocol: /^https?$/u })
  .max(MCP_LIMITS.urlCharacters)
  .refine((value) => {
    const url = URL.parse(value);
    return (
      url !== null &&
      url.username === '' &&
      url.password === '' &&
      /^https?:\/\//iu.test(value) &&
      !/[#\\]/u.test(value) &&
      !/^https?:\/\/[^/?]*@/iu.test(value)
    );
  })
  .meta({ title: 'Streamable HTTP endpoint' });
const token = z
  .string()
  .min(1)
  .max(CONNECTION_CREDENTIALS_BOUNDS.apiKeyCharacters)
  .regex(/^[A-Za-z0-9._~+/-]+=*$/u)
  .meta({ title: 'Bearer token', secret: true });

const fields = z.strictObject({ endpoint, token });
export const mcpCredentialSchema = fields.extend({
  type: z.literal(MCP_AUTH_TYPE),
});
export type McpCredential = z.output<typeof mcpCredentialSchema>;

export const MCP_CONNECTION = {
  authType: MCP_AUTH_TYPE,
  presentation: {
    requirement: 'MCP connection',
    choice: MCP_PROVIDER_KEY,
    pickerOrder: 21,
    name: 'MCP',
    purpose: 'Call tools on an MCP server',
    credential: 'Bearer token',
    savedCredential: 'Bearer token',
    usedBy: 'MCP Call Tool steps',
    nameSuffix: 'MCP',
  },
  schema: mcpCredentialSchema,
  fields,
  auth: { kind: 'bearer', field: 'token' },
  test: { kind: 'lookup', key: MCP_TOOLS_LOOKUP },
  slot: { key: MCP_AUTH_TYPE, primary: true },
} as const satisfies ConnectionDefinition<McpCredential>;
