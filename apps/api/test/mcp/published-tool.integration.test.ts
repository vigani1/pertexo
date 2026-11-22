import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  apiTokenCreateResponseSchema,
  MCP_PROTOCOL_VERSION,
  MCP_STATUS_TOOL_NAME,
} from '@pertexo/contracts';
import { betterAuthIntegrationEnabled } from '../support/better-auth/real-api.support.js';
import { createRealStack } from '../support/real-stack/stack.js';
import {
  ownWorkspace,
  publishDraft,
  publishGraph,
  signUp,
  step,
  type StackOwner,
} from '../support/real-stack/owner.js';
import { mcpClient, pendingReference } from './client.js';
import { expose, readExposure } from './exposure.js';
import { mcpExposureCases } from './exposure.cases.js';
import { mcpAdmissionCases } from './admission.cases.js';

const toolName = 'greet';
const graph = {
  nodes: [step('manual', 'core.manual', 0)],
  edges: [],
  callable: {
    input: {
      type: 'object',
      properties: [
        { name: 'name', required: true, valueType: { type: 'string' } },
      ],
    },
    resultType: { type: 'string' },
    result: { kind: 'run_input', path: '$.name' },
  },
};

describe.runIf(betterAuthIntegrationEnabled)(
  'Published workflows over MCP',
  () => {
    const stack = createRealStack('mcp');
    let running: Awaited<ReturnType<typeof stack.boot>>;
    let owner: StackOwner;
    let foreign: StackOwner;
    let first: Awaited<ReturnType<typeof credential>>;
    let second: Awaited<ReturnType<typeof credential>>;

    beforeAll(async () => {
      await stack.create();
      running = await stack.boot({
        WORKSPACE_QUEUED_RUN_LIMIT: '2',
        AUTH_SIGN_UP_MODE: 'open',
      });
      const send = await signUp(stack, running.origin);
      owner = await ownWorkspace(send);
      foreign = await ownWorkspace(send);
      first = await credential(owner, 'First MCP client');
      second = await credential(foreign, 'Foreign MCP client');
    });
    afterAll(() => stack.close());

    it('negotiates stateless JSON transport and keeps MCP authority off REST', async () => {
      const client = first.client;
      const initialized = await client.result(
        client.request('initialize', {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: { experimental: { example: {} } },
          clientInfo: {
            name: 'Pertexo test client',
            version: '1',
            title: 'Example client',
          },
          _meta: { 'example/client': true },
        }),
      );
      expect(initialized).toMatchObject({
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: { tools: {} },
      });
      const notification = await client.request(
        'notifications/initialized',
        {},
        undefined,
        true,
      );
      expect(notification.status).toBe(202);
      expect(await notification.text()).toBe('');
      expect(await client.result(client.request('ping'))).toEqual({});
      const stream = await fetch(client.endpoint);
      expect(stream.status).toBe(405);
      expect(stream.headers.get('allow')).toBe('POST');
      const anonymous = await fetch(client.endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
      });
      expect(anonymous.status).toBe(401);
      expect(anonymous.headers.get('cache-control')).toBe('private, no-store');
      const foreignOrigin = await fetch(client.endpoint, {
        method: 'POST',
        headers: { origin: 'https://foreign.example' },
      });
      expect(foreignOrigin.status).toBe(403);
      const unsupportedProtocol = await fetch(client.endpoint, {
        method: 'POST',
        headers: { 'mcp-protocol-version': '2025-03-26' },
      });
      expect(unsupportedProtocol.status).toBe(400);
      expect(
        (
          await client.request(
            'tools/list',
            {},
            { origin: 'https://foreign.example' },
          )
        ).status,
      ).toBe(403);
      expect(
        (
          await client.request(
            'ping',
            {},
            { 'mcp-protocol-version': '2025-03-26' },
          )
        ).status,
      ).toBe(400);
      expect(
        (await client.request('ping', {}, { 'mcp-protocol-version': '' }))
          .status,
      ).toBe(400);
      expect(
        (
          await mcpClient(
            running.origin,
            foreign.workspaceId,
            first.secret,
          ).request('tools/list')
        ).status,
      ).toBe(403);
      const read = await fetch(`${running.origin}${owner.base}/workflows`, {
        headers: client.headers,
      });
      expect(read.status).toBe(403);
      const oversized = await first.client.call(toolName, {
        name: 'a'.repeat(300 * 1024),
      });
      expect(oversized.status).toBe(413);
    });

    it('admits a valid typed call once, replays concurrent duplicates and projects the retained result', async () => {
      const workflow = await publishGraph(owner, 'MCP greeting', graph);
      await expose(owner, workflow, toolName);
      expect((await first.client.list()).tools).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            name: toolName,
            inputSchema: {
              type: 'object',
              properties: { name: { type: 'string' } },
              required: ['name'],
              additionalProperties: false,
            },
          }),
          expect.objectContaining({ name: MCP_STATUS_TOOL_NAME }),
        ]),
      );
      expect(
        (await second.client.list()).tools.map(({ name }) => name),
      ).toEqual([MCP_STATUS_TOOL_NAME]);

      for (const args of [{ name: 42 }, { name: 'valid', extra: true }]) {
        expect(await first.client.invoke(toolName, args)).toMatchObject({
          isError: true,
          structuredContent: { code: 'invalid_input' },
        });
      }
      expect(await runsOf(workflow.workflowId)).toHaveLength(0);

      const key = randomUUID();
      const args = { name: 'sensitive-input-for-audit-check' };
      const [accepted, duplicate] = await Promise.all([
        first.client.invoke(toolName, args, key),
        first.client.result(
          first.client.request('tools/call', {
            name: toolName,
            arguments: args,
            extra: 'client extension',
            _meta: { 'pertexo/idempotencyKey': key, 'example/client': true },
          }),
        ),
      ]);
      expect(accepted).toMatchObject({
        isError: false,
        structuredContent: {
          status: 'pending',
        },
      });
      expect(duplicate).toEqual(accepted);
      expect(await first.client.invoke(toolName, args, key)).toEqual(accepted);
      expect(
        (await first.client.call(toolName, { name: 'changed' }, key)).status,
      ).toBe(409);
      const invocation = pendingReference(accepted);
      const another = await credential(
        owner,
        'Second MCP client in the workspace',
      );
      expect(await another.client.status(invocation)).toMatchObject({
        isError: true,
      });
      expect(await second.client.status(invocation)).toMatchObject({
        isError: true,
      });

      await expect
        .poll(
          async () => (await first.client.status(invocation)).structuredContent,
          { timeout: 15_000 },
        )
        .toEqual({ status: 'completed', result: args.name });
      const [run] = await runsOf(workflow.workflowId);
      expect(await runsOf(workflow.workflowId)).toHaveLength(1);
      expect(run?.input_ref).toEqual({ kind: 'inline', value: args });
      const audit = await stack.queryAsOwner<{
        actor_user_id: string;
        request_id: string;
      }>(
        "select action,target_id,actor_user_id,request_id,metadata from app.audit_events where workspace_id=$1 and action like 'workflow.mcp.%' and (target_id=$2 or target_id=$3) order by occurred_at",
        [owner.workspaceId, workflow.workflowId, run?.id],
      );
      expect(audit.rows).toMatchObject([
        { action: 'workflow.mcp.exposed', target_id: workflow.workflowId },
        {
          action: 'workflow.mcp.invoked',
          target_id: run?.id,
          metadata: {
            tokenId: first.id,
            workflowId: workflow.workflowId,
            workflowVersionId: workflow.versionId,
            toolName,
          },
        },
      ]);
      expect(audit.rows[1]?.actor_user_id).toEqual(expect.any(String));
      expect(audit.rows[1]?.request_id).toEqual(expect.any(String));
      expect(JSON.stringify(audit.rows)).not.toContain(args.name);
      expect(JSON.stringify(audit.rows)).not.toContain(first.secret);

      await stack.queryAsOwner(
        'delete from app.idempotency_records where resource_id=$1',
        [run?.id],
      );
      expect((await first.client.status(invocation)).structuredContent).toEqual(
        { status: 'completed', result: args.name },
      );
      await stack.queryAsOwner(
        "update app.workflow_runs set completed_at=completed_at-interval '31 days', started_at=started_at-interval '31 days', created_at=created_at-interval '31 days', input_ref_expires_at=input_ref_expires_at-interval '31 days' where id=$1",
        [run?.id],
      );
      expect(await first.client.status(invocation)).toMatchObject({
        isError: true,
      });
    });

    it('rechecks folder grants, explicit exposure revision and bearer revocation', async () => {
      const sender = await signUp(stack, running.origin);
      const otherWorkspace = await ownWorkspace(sender);
      const member = { ...owner, send: sender };
      const found = await stack.queryAsOwner<{ user_id: string }>(
        "select user_id from app.workspace_memberships where workspace_id=$1 and role='owner'",
        [otherWorkspace.workspaceId],
      );
      const userId = found.rows[0]?.user_id;
      if (userId === undefined)
        throw new Error('Workspace owner was not found');
      await stack.queryAsOwner(
        "insert into app.workspace_memberships(workspace_id,user_id,role,status) values($1,$2,'builder','active')",
        [owner.workspaceId, userId],
      );
      const delegated = await credential(member, 'Folder client');
      const name = 'folder_tool';
      const workflow = await publishGraph(owner, 'Folder tool', graph);
      await expose(owner, workflow, name);
      const pending = await delegated.client.invoke(name, {
        name: 'Authorized',
      });
      expect(pending.isError).toBe(false);
      const invocation = pendingReference(pending);
      const folder = randomUUID();
      await stack.queryAsOwner(
        "insert into app.workflow_folders(workspace_id,id,name,name_key,access_mode) values($1,$2,'Restricted MCP','restricted mcp','restricted')",
        [owner.workspaceId, folder],
      );
      await stack.queryAsOwner(
        'insert into app.workflow_organization_state(workspace_id,workflow_id,folder_id) values($1,$2,$3) on conflict(workspace_id,workflow_id) do update set folder_id=excluded.folder_id',
        [owner.workspaceId, workflow.workflowId, folder],
      );
      expect(
        (await delegated.client.list()).tools.map((tool) => tool.name),
      ).not.toContain(name);
      expect(
        (await delegated.client.invoke(name, { name: 'Hidden' })).isError,
      ).toBe(true);
      expect((await delegated.client.status(invocation)).isError).toBe(true);

      const sharing = await owner.send(
        'POST',
        `${owner.base}/workflow-folders/${folder}/sharing`,
        {
          mode: 'restricted',
          expectedFolderRevision: 1,
          grants: [{ kind: 'member', userId, access: 'editor' }],
        },
      );
      expect(sharing.status, await sharing.text()).toBe(200);
      expect(
        (await delegated.client.list()).tools.map((tool) => tool.name),
      ).toContain(name);
      expect((await delegated.client.status(invocation)).isError).toBe(false);
      const settings = await readExposure(owner, workflow.path);
      expect(
        (
          await owner.send('PUT', `${workflow.path}/mcp`, {
            kind: 'unexpose',
            expectedVersionId: settings.publishedVersionId,
            expectedRevision: settings.exposure?.revision,
          })
        ).status,
      ).toBe(200);
      expect((await delegated.client.status(invocation)).isError).toBe(true);
      expect(
        (await delegated.client.list()).tools.map((tool) => tool.name),
      ).not.toContain(name);
      await expose(owner, workflow, name);
      expect((await delegated.client.status(invocation)).isError).toBe(true);
      const fresh = await delegated.client.invoke(name, {
        name: 'New exposure',
      });
      expect(fresh.isError).toBe(false);
      const republished = await publishDraft(owner, workflow.path, {
        ...graph,
        callable: {
          ...graph.callable,
          result: { kind: 'literal', value: 'Changed' },
        },
      });
      expect(republished).not.toBe(workflow.versionId);
      expect(
        (await delegated.client.list()).tools.map((tool) => tool.name),
      ).not.toContain(name);
      expect(
        (await delegated.client.status(pendingReference(fresh))).isError,
      ).toBe(true);
      expect(
        (await delegated.client.invoke(name, { name: 'Stale' })).isError,
      ).toBe(true);

      expect(
        (
          await sender(
            'POST',
            `${owner.base}/api-tokens/${delegated.id}/revoke`,
            {},
          )
        ).status,
      ).toBe(200);
      expect((await delegated.client.request('tools/list')).status).toBe(401);
    });

    it('returns a safe MCP error for a run that cannot produce its declared result', async () => {
      const broken = {
        ...graph,
        callable: { ...graph.callable, result: { kind: 'literal', value: 42 } },
      };
      const workflow = await publishGraph(owner, 'Failing tool', broken);
      await expose(owner, workflow, 'failing');
      const accepted = await first.client.invoke('failing', {
        name: 'Private',
      });
      expect(accepted.isError).toBe(false);
      const reference = pendingReference(accepted);
      await expect
        .poll(
          async () =>
            (await first.client.status(reference)).structuredContent.status,
          { timeout: 15_000 },
        )
        .toBe('failed');
      expect((await first.client.status(reference)).isError).toBe(true);
    });

    mcpExposureCases(() => owner, graph);
    mcpAdmissionCases({
      getWorkspace: () => foreign,
      getToken: () => second,
      stopWorker: () => running.stopWorker(),
      credential,
      runsOf,
      graph,
    });

    async function credential(workspace: StackOwner, name: string) {
      const response = await workspace.send(
        'POST',
        `${workspace.base}/api-tokens`,
        { name, scopes: ['mcp:invoke'] },
      );
      const text = await response.text();
      expect(response.status, text).toBe(201);
      const token = apiTokenCreateResponseSchema.parse(JSON.parse(text));
      if (token.replayed) throw new Error('Fresh token replayed');
      return {
        id: token.token.id,
        secret: token.secret,
        client: mcpClient(running.origin, workspace.workspaceId, token.secret),
      };
    }

    async function runsOf(workflowId: string) {
      return (
        await stack.queryAsOwner<{ id: string; input_ref: unknown }>(
          'select id,input_ref from app.workflow_runs where workflow_id=$1',
          [workflowId],
        )
      ).rows;
    }
  },
);
