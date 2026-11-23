import { STORED_EXECUTION_VALUE_LIMITS } from '@pertexo/node-sdk';
import { measureBoundedJson } from '@pertexo/workflow-model';
import {
  MCP_PROTOCOL_VERSION,
  MCP_STATUS_TOOL_NAME,
  type McpRequest,
} from '@pertexo/contracts';
import {
  McpToolUnavailableError,
  parseInvocationReference,
  type WorkflowRunDatabase,
} from '@pertexo/core/runs';
import type { LiveRunEventSource } from '../workflow-runs/events/stream.js';
import { waitForMcpResult } from './wait-for-result.js';
import type { HttpRateLimitAdmission } from '../platform/rate-limit/admission.js';
import type { requestIdentifiers } from '../workspaces/request/caller.js';
import { statusArguments, statusToolInput } from './rpc.js';

export type McpRuntime = Readonly<{
  runs: Pick<
    WorkflowRunDatabase,
    'invokeMcpTool' | 'listMcpTools' | 'readMcpToolStatus'
  >;
  catalog: unknown;
  liveSource: LiveRunEventSource;
}>;

const statusTool = {
  name: MCP_STATUS_TOOL_NAME,
  description: 'Check the retained result of a workflow invocation.',
  inputSchema: statusToolInput,
};

type Caller = Parameters<WorkflowRunDatabase['readMcpToolStatus']>[0] &
  ReturnType<typeof requestIdentifiers>;
type Actor = Omit<Caller, 'runId' | 'invocation'>;

export class McpService {
  public constructor(
    private readonly runtime: McpRuntime,
    private readonly limits: HttpRateLimitAdmission,
  ) {}

  public async dispatch(
    input: Exclude<McpRequest, { method: 'notifications/initialized' }>,
    actor: Actor,
    disconnected: AbortSignal,
  ): Promise<unknown> {
    const subject = { tokenId: actor.tokenId, workspaceId: actor.workspaceId };
    switch (input.method) {
      case 'initialize':
        return {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: { name: 'pertexo', version: '1' },
        };
      case 'ping':
        return {};
      case 'tools/list': {
        await this.limits.admit('mcp_list', subject);
        const page = await this.runtime.runs.listMcpTools(
          { catalog: this.runtime.catalog },
          {
            ...actor,
            after: input.params?.cursor,
          },
        );
        return {
          ...page,
          tools:
            input.params?.cursor === undefined
              ? [statusTool, ...page.tools]
              : page.tools,
        };
      }
      case 'tools/call': {
        const { name, arguments: args, _meta } = input.params;
        if (name === MCP_STATUS_TOOL_NAME) {
          await this.limits.admit('mcp_status', subject);
          const parsed = statusArguments.safeParse(args);
          if (!parsed.success) throw new McpToolUnavailableError();
          const { invocation } = parsed.data;
          const runId = parseInvocationReference(invocation);
          if (runId === undefined) throw new McpToolUnavailableError();
          return toolResult(
            await this.runtime.runs.readMcpToolStatus({
              ...actor,
              runId,
              invocation,
              signal: disconnected,
            }),
          );
        }
        await this.limits.admit('mcp_call', subject);
        const { inlineBytes, depth, members } = STORED_EXECUTION_VALUE_LIMITS;
        if (
          !measureBoundedJson(args, { bytes: inlineBytes, depth, members }).ok
        )
          return toolResult({ status: 'failed', code: 'invalid_input' });
        const accepted = await this.runtime.runs.invokeMcpTool(
          { catalog: this.runtime.catalog },
          {
            ...actor,
            name,
            arguments: args,
            key: _meta?.['pertexo/idempotencyKey'],
          },
        );
        return toolResult(
          await waitForMcpResult(this.runtime, {
            ...actor,
            ...accepted,
            disconnected,
            waitMillis: _meta?.['pertexo/waitMillis'],
          }),
        );
      }
    }
  }
}

export function toolResult<Result extends Readonly<{ status: string }>>(
  result: Result,
) {
  return {
    isError: result.status === 'failed',
    structuredContent: result,
    content: [{ type: 'text', text: JSON.stringify(result) }],
  };
}
