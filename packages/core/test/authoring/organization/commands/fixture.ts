import {
  workflowTagCreateRequestSchema,
  workflowTagRenameRequestSchema,
  workflowTagReplaceRequestSchema,
} from '@pertexo/contracts';
import { randomBytes, randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';

import {
  commandKey,
  createOrganizationOwnedFixture,
  type OrganizationOwnedFixture,
} from '../owned.fixture.js';

type Scope = Awaited<ReturnType<OrganizationOwnedFixture['scope']>>;

interface Result {
  tag?: { id: string; key: string; revision: number };
  organizationRevision?: number;
  tagIds?: readonly string[];
  isFavorite?: boolean;
  replayed: boolean;
  detachedWorkflowCount?: number;
}

export let fixture: OrganizationOwnedFixture;

let fixtureCreated = false;

export function required<T>(value: T | undefined): T {
  if (value === undefined)
    throw new Error('Missing expected F07 fixture value');
  return value;
}

export function api<T>(
  s: Scope,
  actor: string,
  work: (client: PoolClient) => Promise<T>,
) {
  return fixture.transaction(fixture.api, s.workspace, actor, work);
}

export function owner<
  Row extends Record<string, unknown> = Record<string, unknown>,
>(s: Scope, text: string, values: unknown[] = []) {
  return fixture.transaction(fixture.owner, s.workspace, s.actor, (client) =>
    client.query<Row>(text, values),
  );
}

export async function tag(
  s: Scope,
  operation: 'tag.create' | 'tag.rename' | 'tag.delete',
  {
    id,
    body,
    key = commandKey(),
    actor = s.actor,
  }: Readonly<{
    id: string | null;
    body: Readonly<{ key?: string; expectedTagRevision?: number }>;
    key?: string | undefined;
    actor?: string | undefined;
  }>,
): Promise<Result> {
  const command = {
    workspaceId: s.workspace,
    actorId: actor,
    idempotencyKey: key,
  };
  if (operation === 'tag.create')
    return fixture.tags.createTag({
      ...command,
      ...workflowTagCreateRequestSchema.parse({ key: body.key ?? '' }),
    });
  const tagId = required(id ?? undefined);
  const expectedTagRevision = body.expectedTagRevision ?? 0;
  return operation === 'tag.rename'
    ? fixture.tags.renameTag({
        ...command,
        tagId,
        ...workflowTagRenameRequestSchema.parse({
          key: body.key ?? '',
          expectedTagRevision,
        }),
      })
    : fixture.tags.deleteTag({ ...command, tagId, expectedTagRevision });
}

export async function createTag(
  s: Scope,
  name = `tag-${randomBytes(4).toString('hex')}`,
) {
  const result = await tag(s, 'tag.create', { id: null, body: { key: name } });
  if (!result.tag) throw new Error('Missing created tag');
  return result.tag;
}

export async function assignment(
  s: Scope,
  workflow: string,
  {
    ids,
    revision = 1,
    key = commandKey(),
    actor = s.actor,
  }: Readonly<{
    ids: string[];
    revision?: number | undefined;
    key?: string | undefined;
    actor?: string | undefined;
  }>,
): Promise<Result> {
  return fixture.tags.replaceTags({
    workspaceId: s.workspace,
    actorId: actor,
    idempotencyKey: key,
    workflowId: workflow,
    ...workflowTagReplaceRequestSchema.parse({
      tagIds: ids,
      expectedOrganizationRevision: revision,
    }),
  });
}

export function favorite(s: Scope, workflow: string, value: boolean) {
  return fixture.favorites.setFavorite({
    workspaceId: s.workspace,
    actorId: s.viewer,
    workflowId: workflow,
    favorite: value,
  });
}

export async function favoritesOf(s: Scope, actor: string) {
  return (
    await owner<{ workflow_id: string }>(
      s,
      'select workflow_id from app.workflow_favorites where workspace_id=$1 and actor_id=$2',
      [s.workspace, actor],
    )
  ).rows.map((row) => row.workflow_id);
}

export async function removeAndRejoin(s: Scope) {
  await fixture.identity.removeWorkspaceMember({
    workspaceId: s.workspace,
    actorUserId: s.actor,
    targetUserId: s.viewer,
    expectedRoleRevision: 1,
    idempotencyKey: randomUUID(),
  });
  // Privileged membership fixture projects the existing invitation rejoin shape;
  // this does not claim live invitation transport qualification.
  await owner(
    s,
    "update app.workspace_memberships set status='active',role_revision=role_revision+1 where workspace_id=$1 and user_id=$2",
    [s.workspace, s.viewer],
  );
}

export async function beforeAllFixture1() {
  fixture = await createOrganizationOwnedFixture();
  fixtureCreated = true;
}

export async function afterAllFixture2() {
  if (fixtureCreated) await fixture.close();
}
