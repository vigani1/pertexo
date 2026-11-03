import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

import {
  ChangeWorkspaceMemberRoleUseCase,
  CreateWorkspaceUseCase,
  GetCurrentUserUseCase,
  ListAccessibleWorkspacesUseCase,
  ListWorkspaceMembersUseCase,
  RenameWorkspaceUseCase,
  UpdateUserProfileUseCase,
  UserController,
  WorkspaceController,
  WorkspaceDiscoveryController,
  WorkspaceLifecycleUseCase,
  WorkspaceMembersController,
  WorkspaceMembershipController,
  WorkspaceMembershipLifecycleUseCase,
} from '../../../src/workspaces/index.js';
import { RemoveWorkspaceMemberUseCase } from '../../../src/workspaces/members/removal.js';
import { WORKSPACE_AUTHORIZATION } from '../../../src/workspaces/tokens.js';
import { FakeIdentityModule } from '../../support/identity-module.js';
import {
  HARNESS_ACTOR_ID as actorId,
  ownerAccess,
  routeHarness,
} from '../../support/route-harness.js';

const workspaceId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const targetUserId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const at = new Date('2026-08-20T12:00:00.000Z');
const one = `/v1/workspaces/${workspaceId}`;
const workspace = {
  id: workspaceId,
  name: 'Operations',
  slug: 'operations',
  status: 'active',
  revision: 2,
  createdBy: actorId,
  deletionRequestedAt: null,
  deletionRequestedBy: null,
  deletionReason: null,
  purgeAfter: null,
  createdAt: at,
  updatedAt: at,
};
const deletionRequested = {
  workspaceId,
  change: 'deletion_requested',
  occurredAt: '2026-08-20T12:00:00.000Z',
};

const store = {
  findUserById: vi.fn(),
  listWorkspaceMembers: vi.fn(),
  changeWorkspaceMemberRole: vi.fn(),
  removeWorkspaceMember: vi.fn(),
  listAccessibleWorkspaces: vi.fn(),
  createWorkspaceWithOwner: vi.fn(),
  renameWorkspace: vi.fn(),
};
const lifecycle = { requestDeletion: vi.fn() };
const membership = {
  suspend: vi.fn(),
  reactivate: vi.fn(),
  transferOwnership: vi.fn(),
  leave: vi.fn(),
};
// Nest dynamic modules require a class token.
// eslint-disable-next-line @typescript-eslint/no-extraneous-class
class WorkspaceRoutesUnderTest {}
let harness: Awaited<ReturnType<typeof routeHarness>>;

/** Real routes, guards and use cases over a store this test controls. */
beforeAll(async () => {
  harness = await routeHarness({
    module: WorkspaceRoutesUnderTest,
    imports: [{ module: FakeIdentityModule }],
    controllers: [
      UserController,
      WorkspaceDiscoveryController,
      WorkspaceMembersController,
      WorkspaceController,
      WorkspaceMembershipController,
    ],
    providers: [
      { provide: WORKSPACE_AUTHORIZATION, useValue: ownerAccess },
      {
        provide: GetCurrentUserUseCase,
        useValue: new GetCurrentUserUseCase(store),
      },
      { provide: UpdateUserProfileUseCase, useValue: { execute: vi.fn() } },
      {
        provide: ListAccessibleWorkspacesUseCase,
        useValue: new ListAccessibleWorkspacesUseCase(store),
      },
      {
        provide: ListWorkspaceMembersUseCase,
        useValue: new ListWorkspaceMembersUseCase(store, ownerAccess),
      },
      {
        provide: ChangeWorkspaceMemberRoleUseCase,
        useValue: new ChangeWorkspaceMemberRoleUseCase(store),
      },
      {
        provide: RemoveWorkspaceMemberUseCase,
        useValue: new RemoveWorkspaceMemberUseCase(store),
      },
      {
        provide: CreateWorkspaceUseCase,
        useValue: new CreateWorkspaceUseCase(store),
      },
      { provide: WorkspaceLifecycleUseCase, useValue: lifecycle },
      { provide: WorkspaceMembershipLifecycleUseCase, useValue: membership },
      {
        provide: RenameWorkspaceUseCase,
        useValue: new RenameWorkspaceUseCase(store),
      },
    ],
  });
});
afterAll(() => harness.close());
beforeEach(() => {
  vi.clearAllMocks();
  store.listWorkspaceMembers.mockResolvedValue({ items: [] });
  store.listAccessibleWorkspaces.mockResolvedValue({ items: [] });
  lifecycle.requestDeletion.mockResolvedValue(deletionRequested);
});

const command = (
  method: 'POST' | 'PUT',
  url: string,
  body: unknown,
  key = 'workspace-command',
) => harness.send(method, url, { body, headers: { 'idempotency-key': key } });

describe('workspace routes', () => {
  it('requests deletion as the signed-in actor, with what the guard proved', async () => {
    const reply = await command('POST', `${one}/deletion`, {
      reason: 'operator request',
    });
    expect(reply.statusCode, reply.payload).toBe(200);
    expect(lifecycle.requestDeletion).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        actor: expect.objectContaining({ actorId, workspaceId }) as unknown,
        authorizedWorkspace: expect.objectContaining({
          workspaceId,
          capability: 'workspace:manage',
        }) as unknown,
        routeWorkspaceId: workspaceId,
        reason: 'operator request',
        idempotencyKey: 'workspace-command',
      }),
    );
  });

  it('refuses a workspace that is not an identifier before any lifecycle work', async () => {
    const reply = await command('POST', '/v1/workspaces/not-a-uuid/deletion', {
      reason: 'retire it',
    });
    expect(reply.statusCode).toBe(400);
    expect(lifecycle.requestDeletion).not.toHaveBeenCalled();
  });

  it('answers the current profile and keeps it out of caches', async () => {
    store.findUserById.mockResolvedValue({
      id: actorId,
      email: 'person@example.test',
      displayName: 'Person',
      status: 'active',
      profileRevision: 4,
      createdAt: at,
      updatedAt: at,
    });
    const reply = await harness.send('GET', '/v1/users/me');
    expect(reply.statusCode, reply.payload).toBe(200);
    expect(reply.json()).toEqual({
      id: actorId,
      email: 'person@example.test',
      displayName: 'Person',
      status: 'active',
      revision: 4,
      createdAt: '2026-08-20T12:00:00.000Z',
      updatedAt: '2026-08-20T12:00:00.000Z',
    });
    expect(reply.headers['cache-control']).toBe('private, no-store');
  });

  it('pages members within bounds and keeps them out of caches', async () => {
    const reply = await harness.send('GET', `${one}/members`, {
      query: { limit: '2' },
    });
    expect(reply.statusCode, reply.payload).toBe(200);
    expect(reply.headers['cache-control']).toBe('private, no-store');
    expect(store.listWorkspaceMembers).toHaveBeenCalledWith(
      workspaceId,
      actorId,
      { limit: 2 },
    );
    const outside = await harness.send('GET', `${one}/members`, {
      query: { limit: '101' },
    });
    expect(outside.statusCode).toBe(400);
  });

  it('forwards a member role change and refuses unknown fields', async () => {
    store.changeWorkspaceMemberRole.mockResolvedValue({
      userId: targetUserId,
      role: 'operator',
      roleRevision: 2,
      changed: true,
      replayed: false,
    });
    const url = `${one}/members/${targetUserId}/role`;
    const reply = await command('POST', url, {
      role: 'operator',
      expectedRoleRevision: 1,
    });
    expect(reply.statusCode, reply.payload).toBe(200);
    expect(store.changeWorkspaceMemberRole).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId,
        actorUserId: actorId,
        targetUserId,
        role: 'operator',
        expectedRoleRevision: 1,
        idempotencyKey: 'workspace-command',
      }),
    );
    const extra = await command('POST', url, {
      role: 'operator',
      expectedRoleRevision: 1,
      extra: true,
    });
    expect(extra.statusCode).toBe(400);
    expect(store.changeWorkspaceMemberRole).toHaveBeenCalledOnce();
  });

  it.each([
    ['remove', { expectedRoleRevision: 0 }],
    ['remove', { role: 'viewer' }],
    ['suspend', {}],
    ['suspend', { expectedRoleRevision: 1, status: 'active' }],
    ['transfer-ownership', { expectedRoleRevision: 2 }],
  ])('refuses a %s command with body %j', async (path, body) => {
    const reply = await command(
      'POST',
      `${one}/members/${targetUserId}/${path}`,
      body,
    );
    expect(reply.statusCode).toBe(400);
    expect(store.removeWorkspaceMember).not.toHaveBeenCalled();
    for (const command of Object.values(membership))
      expect(command).not.toHaveBeenCalled();
  });

  it('lists only the signed-in person’s workspaces, out of caches', async () => {
    const reply = await harness.send('GET', '/v1/workspaces', {
      query: { limit: '2', after: workspaceId },
    });
    expect(reply.statusCode, reply.payload).toBe(200);
    expect(reply.headers['cache-control']).toBe('private, no-store');
    expect(store.listAccessibleWorkspaces).toHaveBeenCalledWith(actorId, {
      limit: 2,
      after: workspaceId,
    });
    const outside = await harness.send('GET', '/v1/workspaces', {
      query: { limit: '101' },
    });
    expect(outside.statusCode).toBe(400);
  });

  it('creates a workspace with its name trimmed', async () => {
    store.createWorkspaceWithOwner.mockResolvedValue(workspace);
    const reply = await command('POST', '/v1/workspaces', {
      name: ' Operations ',
      slug: 'operations',
    });
    expect(reply.statusCode, reply.payload).toBe(201);
    expect(store.createWorkspaceWithOwner).toHaveBeenCalledWith(
      expect.objectContaining({ ownerUserId: actorId, name: 'Operations' }),
    );
  });

  it('refuses an invalid workspace before creating it', async () => {
    const reply = await command('POST', '/v1/workspaces', {
      name: '',
      slug: 'not valid',
    });
    expect(reply.statusCode).toBe(400);
    expect(store.createWorkspaceWithOwner).not.toHaveBeenCalled();
  });

  it.each([[''], ['one,two']])(
    'refuses a workspace create with idempotency key %j',
    async (key) => {
      const reply = await command(
        'POST',
        '/v1/workspaces',
        { name: 'Operations', slug: 'operations' },
        key,
      );
      expect(reply.statusCode).toBe(400);
      expect(reply.json()).toMatchObject({ code: 'request.invalid' });
      expect(store.createWorkspaceWithOwner).not.toHaveBeenCalled();
    },
  );

  it('forwards a conditional rename and refuses a forged slug', async () => {
    store.renameWorkspace.mockResolvedValue({
      workspace: { ...workspace, name: 'Renamed workspace' },
      changed: true,
      replayed: false,
    });
    const rename = (body: unknown) =>
      harness.send('PATCH', one, {
        body,
        headers: { 'idempotency-key': 'workspace-command' },
      });
    const reply = await rename({
      name: 'Renamed workspace',
      expectedRevision: 1,
    });
    expect(reply.statusCode, reply.payload).toBe(200);
    expect(reply.json()).toMatchObject({
      workspace: { name: 'Renamed workspace', revision: 2 },
      changed: true,
    });
    expect(store.renameWorkspace).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId,
        actorUserId: actorId,
        name: 'Renamed workspace',
        expectedRevision: 1,
        idempotencyKey: 'workspace-command',
      }),
    );
    const forged = await rename({
      name: 'Changed',
      expectedRevision: 1,
      slug: 'forged',
    });
    expect(forged.statusCode).toBe(400);
    expect(store.renameWorkspace).toHaveBeenCalledOnce();
  });
});
