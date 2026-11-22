import { CONNECTION_LOOKUP_LIMITS } from '@pertexo/contracts';
import { z } from 'zod';
import { defineConnectionLookup } from '../providers/connection-lookup.js';
import { openMcpSession } from './client.js';
import {
  MCP_AUTH_TYPE,
  MCP_TOOLS_LOOKUP,
  mcpCredentialSchema,
} from './connections.definition.js';
import { listTools, normalizeToolInput } from './list-tools.js';

export const toolsLookup = defineConnectionLookup({
  key: MCP_TOOLS_LOOKUP,
  authType: MCP_AUTH_TYPE,
  inputSchema: z.undefined(),
  credentialSchema: mcpCredentialSchema,
  async discover(_input, credential, { http, signal }) {
    const session = await openMcpSession(credential, {
      http,
      signal,
      beforeDispatch: () => Promise.resolve(),
    });
    const tools = await listTools(session);
    return {
      items: [...tools.values()].flatMap((tool) => {
        const input = normalizeToolInput(tool);
        if (input === undefined) return [];
        const title =
          tool.title
            ?.trim()
            .slice(0, CONNECTION_LOOKUP_LIMITS.labelCharacters) ?? '';
        return [
          {
            value: tool.name,
            label: title === '' ? tool.name : title,
            ...(tool.description === undefined
              ? {}
              : {
                  description: tool.description.slice(
                    0,
                    CONNECTION_LOOKUP_LIMITS.descriptionCharacters,
                  ),
                }),
            attach: input.schema,
          },
        ];
      }),
    };
  },
});
