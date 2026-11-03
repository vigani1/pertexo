import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WorkflowAuthoringController } from '../../../src/workflow-authoring/http/workflow-authoring.controller.js';
import { WorkflowLifecycleController } from '../../../src/workflow-authoring/http/lifecycle-controller.js';
import { WorkflowVersionsController } from '../../../src/workflow-authoring/http/versions-controller.js';
import {
  CreateWorkflowUseCase,
  GetWorkflowUseCase,
  GetWorkflowDraftUseCase,
  ListWorkflowsUseCase,
  PublishWorkflowUseCase,
  SaveWorkflowDraftUseCase,
  ValidateWorkflowDraftUseCase,
  ListWorkflowVersionsUseCase,
} from '../../../src/workflow-authoring/workflow-authoring.service.js';
import { TransitionWorkflowLifecycleUseCase } from '../../../src/workflow-authoring/commands/lifecycle.js';
import { RenameWorkflowUseCase } from '../../../src/workflow-authoring/commands/rename.js';
import { DuplicateWorkflowUseCase } from '../../../src/workflow-authoring/commands/duplicate.js';
import { RestoreWorkflowVersionUseCase } from '../../../src/workflow-authoring/commands/restore-version.js';
import { WorkflowOrganizationReadsUseCase } from '../../../src/workflow-authoring/organization/reads.js';
import { WORKSPACE_AUTHORIZATION } from '../../../src/workspaces/tokens.js';
import { FakeIdentityModule } from '../../support/identity-module.js';
import { routeHarness } from '../../support/route-harness.js';
import {
  persistence,
  authorization,
  workspaceId,
  workflowId,
  version,
  graph,
} from '../use-cases/fixture.js';

// Nest dynamic modules require a class token.
// eslint-disable-next-line @typescript-eslint/no-extraneous-class
class AuthoringRoutesUnderTest {}
const store = persistence();
const access = authorization();
const url = `/v1/workspaces/${workspaceId}/workflows`;
const one = `${url}/${workflowId}`;
const versionUrl = `${one}/versions/${version().id}/restore`;
let harness: Awaited<ReturnType<typeof routeHarness>>;
let tag: string;
const key = { 'idempotency-key': 'one-command' };
beforeAll(async () => {
  harness = await routeHarness({
    module: AuthoringRoutesUnderTest,
    imports: [{ module: FakeIdentityModule }],
    controllers: [
      WorkflowAuthoringController,
      WorkflowLifecycleController,
      WorkflowVersionsController,
    ],
    providers: [
      { provide: WORKSPACE_AUTHORIZATION, useValue: access },
      { provide: WorkflowOrganizationReadsUseCase, useValue: {} },
      ...[
        CreateWorkflowUseCase,
        GetWorkflowUseCase,
        GetWorkflowDraftUseCase,
        ListWorkflowsUseCase,
        PublishWorkflowUseCase,
        SaveWorkflowDraftUseCase,
        ValidateWorkflowDraftUseCase,
        ListWorkflowVersionsUseCase,
        TransitionWorkflowLifecycleUseCase,
        RenameWorkflowUseCase,
        DuplicateWorkflowUseCase,
        RestoreWorkflowVersionUseCase,
      ].map((useCase) => ({
        provide: useCase,
        useValue: new useCase(store, access),
      })),
    ],
  });
  const draft = await harness.send('GET', `${one}/draft`);
  expect(draft.statusCode).toBe(200);
  tag = String(draft.headers.etag);
});
afterAll(() => harness.close());

describe('workflow authoring HTTP contract', () => {
  it('returns a draft with a strong validator and honors a conditional read', async () => {
    const reply = await harness.send('GET', `${one}/draft`);
    expect(reply.statusCode).toBe(200);
    expect(reply.json()).toMatchObject({ workflowId, graph });
    expect(reply.headers.etag).toBe(tag);
    const unchanged = await harness.send('GET', `${one}/draft`, {
      headers: { 'if-none-match': tag },
    });
    expect(unchanged.statusCode).toBe(304);
    expect(unchanged.body).toBe('');
    const other = await harness.send('GET', `${one}/draft`, {
      headers: { 'if-none-match': '"something-else"' },
    });
    expect(other.statusCode).toBe(200);
  });
  it('creates a workflow and returns its draft validator', async () => {
    const reply = await harness.send('POST', url, {
      body: { name: '  Operations  ' },
      headers: key,
    });
    expect(reply.statusCode).toBe(201);
    expect(reply.json()).toMatchObject({
      workflow: { id: workflowId, name: 'Operations' },
      draft: { workflowId },
    });
    expect(reply.headers.etag).toBe(tag);
  });
  it('saves a graph and restores a version with a fresh validator', async () => {
    for (const [method, path, body] of [
      ['PUT', `${one}/draft`, { graph }],
      ['POST', versionUrl, {}],
    ] as const) {
      const reply = await harness.send(method, path, {
        body,
        headers: { 'if-match': tag },
      });
      expect(reply.statusCode).toBe(200);
      expect(reply.json()).toMatchObject({ workflowId, revision: 2, graph });
      expect(reply.headers.etag).not.toBe(tag);
    }
  });
  it('returns the validation snapshot and publication', async () => {
    const validation = await harness.send('POST', `${one}/validate`);
    expect(validation.statusCode).toBe(200);
    expect(validation.json()).toMatchObject({
      compatibility: { compatible: true },
    });
    expect(validation.headers.etag).toBe(tag);
    const published = await harness.send('POST', `${one}/publish`, {
      headers: { ...key, 'if-match': tag },
    });
    expect(published.statusCode).toBe(200);
    expect(published.json()).toMatchObject({
      version: { id: version().id },
      reused: false,
    });
  });
  it.each(['archive', 'restore'] as const)(
    'accepts %s with an idempotency key',
    async (command) => {
      const reply = await harness.send('POST', `${one}/${command}`, {
        body: { expectedLifecycleRevision: 1 },
        headers: key,
      });
      expect(reply.statusCode).toBe(202);
      expect(reply.json()).toMatchObject({
        workflow: { id: workflowId },
        replayed: false,
      });
    },
  );
  it('renames and duplicates without returning a graph from duplication', async () => {
    const rename = await harness.send('POST', `${one}/rename`, {
      body: { name: 'Invoices', expectedNameRevision: 1 },
      headers: key,
    });
    expect(rename.statusCode).toBe(200);
    expect(rename.json()).toMatchObject({
      workflow: { name: 'Invoices', nameRevision: 2 },
    });
    for (const source of [
      { kind: 'draft' },
      { kind: 'version', versionId: version().id },
    ]) {
      const reply = await harness.send('POST', `${one}/duplicate`, {
        body: { name: 'Copy', source },
        headers: source.kind === 'draft' ? { ...key, 'if-match': tag } : key,
      });
      expect(reply.statusCode).toBe(201);
      expect(reply.json()).toEqual({ workflowId });
      expect(reply.headers.location).toBe(one);
    }
  });
  it.each([
    { method: 'PUT', path: `${one}/draft`, body: { graph } },
    { method: 'POST', path: versionUrl, body: {} },
    {
      method: 'POST',
      path: `${one}/duplicate`,
      body: { name: 'Copy', source: { kind: 'draft' } },
    },
    { method: 'POST', path: `${one}/publish` },
  ] as const)(
    'requires the draft precondition on $path',
    async ({ method, path, ...input }) => {
      expect(
        (await harness.send(method, path, { ...input, headers: key }))
          .statusCode,
      ).toBe(428);
    },
  );
  it.each([
    { command: 'archive', body: { expectedLifecycleRevision: 1 } },
    { command: 'restore', body: { expectedLifecycleRevision: 1 } },
    { command: 'rename', body: { name: 'New', expectedNameRevision: 1 } },
    {
      command: 'duplicate',
      body: {
        name: 'Copy',
        source: { kind: 'version', versionId: version().id },
      },
    },
    { command: 'publish' },
  ])('requires idempotency for $command', async ({ command, ...input }) => {
    expect(
      (
        await harness.send('POST', `${one}/${command}`, {
          ...input,
          headers: { 'if-match': tag },
        })
      ).statusCode,
    ).toBe(400);
  });
  it.each([
    {},
    { expectedLifecycleRevision: 0 },
    { expectedLifecycleRevision: 1.1 },
    { expectedLifecycleRevision: '1' },
    { expectedLifecycleRevision: Number.MAX_SAFE_INTEGER + 1 },
    { expectedLifecycleRevision: 1, cancelRuns: true },
  ])('refuses malformed lifecycle input %j', async (body) => {
    const reply = await harness.send('POST', `${one}/archive`, {
      body,
      headers: key,
    });
    expect(reply.statusCode).toBe(400);
    expect(reply.json()).toHaveProperty('errors');
  });
  it.each([
    {},
    { name: 'Invoices' },
    { name: ' ', expectedNameRevision: 1 },
    { name: 'x'.repeat(129), expectedNameRevision: 1 },
    { name: 'Invoices', expectedNameRevision: 0 },
    { name: 'Invoices', expectedNameRevision: '1' },
    { name: 'Invoices', expectedNameRevision: 1, expectedLifecycleRevision: 1 },
  ])('refuses malformed rename input %j', async (body) => {
    expect(
      (await harness.send('POST', `${one}/rename`, { body, headers: key }))
        .statusCode,
    ).toBe(400);
  });
  it.each([null, [], { graph }, { expectedRevision: 1 }])(
    'refuses malformed version restore input %j',
    async (body) => {
      expect(
        (
          await harness.send('POST', versionUrl, {
            body,
            headers: { 'if-match': tag },
          })
        ).statusCode,
      ).toBe(400);
    },
  );
  it.each([
    { name: 'Copy', source: { kind: 'draft' }, graph: {} },
    { name: 'Copy', source: { kind: 'draft', versionId: version().id } },
    { name: 'Copy', source: { kind: 'version' } },
    {
      name: 'Copy',
      source: { kind: 'version', versionId: version().id, graph: {} },
    },
  ])('refuses client graph or malformed selectors %j', async (body) => {
    expect(
      (
        await harness.send('POST', `${one}/duplicate`, {
          body,
          headers: { ...key, 'if-match': tag },
        })
      ).statusCode,
    ).toBe(400);
  });
  it.each([
    { include: 'origin' },
    { include: 'templateOrigin', extra: 'yes' },
    { extra: 'yes' },
  ])('refuses malformed projections %j', async (query) => {
    expect((await harness.send('GET', one, { query })).statusCode).toBe(400);
  });
  it('keeps default metadata available and an unavailable projection explicit', async () => {
    expect((await harness.send('GET', one)).json()).toMatchObject({
      workflow: { id: workflowId },
    });
    const origin = await harness.send('GET', one, {
      query: { include: 'templateOrigin' },
    });
    expect(origin.statusCode).toBe(503);
  });
  it('accepts an exact version filter and rejects conflicting pagination', async () => {
    expect(
      (
        await harness.send('GET', `${one}/versions`, {
          query: { versionId: version().id },
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await harness.send('GET', `${one}/versions`, {
          query: { versionId: version().id, after: 'old' },
        })
      ).statusCode,
    ).toBe(400);
  });
  it.each([
    { after: '' },
    { after: 'x'.repeat(2049) },
    { limit: '101' },
    { pinsWorkflowId: workflowId, include: 'organization' },
  ])('refuses malformed list input %j', async (query) => {
    expect((await harness.send('GET', url, { query })).statusCode).toBe(400);
  });
  it.each([
    { actorId: 'private' },
    { favoritesOnly: 'false' },
    { include: 'templateOrigin' },
    { query: '表'.repeat(43) },
  ])('refuses invalid organization list input %j', async (query) => {
    expect((await harness.send('GET', url, { query })).statusCode).toBe(400);
  });
  it('refuses invalid route ids and graph fields', async () => {
    expect(
      (
        await harness.send('POST', url.replace(workspaceId, 'not-a-uuid'), {
          body: { name: 'Operations' },
          headers: key,
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await harness.send('PUT', `${one}/draft`, {
          body: { graph: { ...graph, unexpected: true } },
          headers: { 'if-match': tag },
        })
      ).statusCode,
    ).toBe(400);
  });
});
