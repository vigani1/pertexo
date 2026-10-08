import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  commandKey,
  createOrganizationOwnedFixture,
  organizationFixtureEnabled,
  type OrganizationOwnedFixture,
} from './support/workflow-organization-owned.fixture.js';

type Scope = Awaited<ReturnType<OrganizationOwnedFixture['scope']>>;
interface Result {
  tag?: { id: string; key: string; revision: number };
  organizationRevision?: number;
  tagIds?: string[];
  favoriteRevision?: string;
  isFavorite?: boolean;
  replayed: boolean;
  detachedWorkflowCount?: number;
}
interface Absence {
  token: string;
  generation: string;
  issued: number;
  expires: number;
}
let fixture: OrganizationOwnedFixture;
let fixtureCreated = false;
function required<T>(value: T | undefined): T {
  if (value === undefined)
    throw new Error('Missing expected F07 fixture value');
  return value;
}
const signingKey = randomBytes(32); // Internal SQL fixture proof, NOT API MAC qualification.

function api<T>(
  s: Scope,
  actor: string,
  work: (client: PoolClient) => Promise<T>,
) {
  return fixture.transaction(fixture.api, s.workspace, actor, work);
}
function owner<Row extends Record<string, unknown> = Record<string, unknown>>(
  s: Scope,
  text: string,
  values: unknown[] = [],
) {
  return fixture.transaction(fixture.owner, s.workspace, s.actor, (client) =>
    client.query<Row>(text, values),
  );
}
async function command(client: PoolClient, text: string, values: unknown[]) {
  const result = await client.query<{ result: Result }>(text, values);
  if (!result.rows[0]) throw new Error('Missing F07 command result');
  return result.rows[0].result;
}
function tag(
  s: Scope,
  operation: string,
  id: string | null,
  body: object,
  key = commandKey(),
  actor = s.actor,
) {
  return api(s, actor, (client) =>
    command(
      client,
      'select app.execute_workflow_tag_command($1,$2,$3,$4::jsonb) result',
      [operation, id, key, JSON.stringify(body)],
    ),
  );
}
async function createTag(
  s: Scope,
  name = `tag-${randomBytes(4).toString('hex')}`,
) {
  const result = await tag(s, 'tag.create', null, { key: name });
  if (!result.tag) throw new Error('Missing created tag');
  return result.tag;
}
function assignment(
  s: Scope,
  workflow: string,
  ids: string[],
  revision = 1,
  key = commandKey(),
  actor = s.actor,
) {
  return api(s, actor, (client) =>
    command(
      client,
      "select app.execute_workflow_tag_assignment_command('tags.replace',$1,$2,$3::jsonb) result",
      [
        workflow,
        key,
        JSON.stringify({ tagIds: ids, expectedOrganizationRevision: revision }),
      ],
    ),
  );
}
function absenceBody(
  s: Scope,
  workflow: string,
  generation: string,
  issued: number,
): Absence {
  const expires = issued + 86400;
  const subkey = createHmac('sha256', signingKey)
    .update('pertexo.workflow.favorite.absence-key.v1')
    .digest();
  const mac = createHmac('sha256', subkey)
    .update(
      JSON.stringify({
        v: 1,
        w: s.workspace,
        a: s.viewer,
        id: workflow,
        g: generation,
        i: issued,
        e: expires,
      }),
    )
    .digest('base64url');
  return {
    token: `absent.v1.${String(issued)}.${String(expires)}.${mac}`,
    generation,
    issued,
    expires,
  };
}
async function absence(s: Scope, workflow: string) {
  return api(s, s.viewer, async (client) => {
    const result = await client.query<{
      result: { generation: string; readAtSeconds: number };
    }>('select app.read_workflow_favorite_generation() result');
    const current = result.rows[0]?.result;
    if (!current) throw new Error('Missing internal favorite snapshot');
    return absenceBody(s, workflow, current.generation, current.readAtSeconds);
  });
}
async function favoriteOn(
  client: PoolClient,
  workflow: string,
  favorite: boolean,
  expected: string,
  proof?: Absence,
  key = commandKey(),
) {
  const body = JSON.stringify({ favorite, expectedFavoriteRevision: expected });
  const prepared = await client.query<{
    result: { kind: string; result?: Result };
  }>('select app.prepare_workflow_favorite_command($1,$2,$3::jsonb) result', [
    workflow,
    key,
    body,
  ]);
  const claim = prepared.rows[0]?.result;
  if (claim?.kind === 'replay' && claim.result) return claim.result;
  expect(claim?.kind).toBe('new');
  return command(
    client,
    'select app.execute_workflow_favorite_command($1,$2,$3::jsonb,$4,$5,$6) result',
    [
      workflow,
      key,
      body,
      proof?.generation ?? null,
      proof?.issued ?? null,
      proof?.expires ?? null,
    ],
  );
}
function favorite(
  s: Scope,
  workflow: string,
  value: boolean,
  expected: string,
  proof?: Absence,
  key = commandKey(),
) {
  return api(s, s.viewer, (client) =>
    favoriteOn(client, workflow, value, expected, proof, key),
  );
}
async function reap(limit = 100) {
  const result = await fixture.maintenance.query<Record<string, number>>(
    'select * from app.reap_workflow_organization($1)',
    [limit],
  );
  return result.rows[0] ?? {};
}
async function removeAndRejoin(s: Scope) {
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

async function begin(
  client: PoolClient,
  s: Scope,
  actor: string,
  privileged = false,
) {
  await client.query('begin');
  await client.query("set local statement_timeout='8s'");
  await client.query(
    "select set_config('app.workspace_id',$1,true),set_config('app.actor_id',$2,true)",
    [s.workspace, actor],
  );
  if (privileged) await client.query('set local role pertexo_owner');
  return required(
    (await client.query<{ pid: number }>('select pg_backend_pid() pid'))
      .rows[0],
  ).pid;
}

async function rollbackRelease(client: PoolClient) {
  try {
    await client.query('rollback');
  } finally {
    client.release();
  }
}

describe.skipIf(!organizationFixtureEnabled)(
  '0134 owned PostgreSQL organization commands',
  () => {
    beforeAll(async () => {
      fixture = await createOrganizationOwnedFixture();
      fixtureCreated = true;
      expect(
        (
          await fixture.owner.query(
            'select writes_enabled from app.workflow_organization_rollout',
          )
        ).rows,
      ).toEqual([{ writes_enabled: true }]);
    }, 120000);
    afterAll(async () => {
      if (fixtureCreated) await fixture.close();
    }, 30000);

    it('normalizes exact ASCII command identity, preserves UUID on rename, and fences stale commands', async () => {
      const s = await fixture.scope(),
        key = commandKey();
      const first = await tag(s, 'tag.create', null, { key: '  OPS-2  ' }, key);
      expect(first.tag?.key).toBe('ops-2');
      expect(await tag(s, 'tag.create', null, { key: 'ops-2' }, key)).toEqual({
        ...first,
        replayed: true,
      });
      await expect(
        tag(s, 'tag.create', null, { key: 'Ops-2' }),
      ).rejects.toMatchObject({ code: 'P7003' });
      if (!first.tag) throw new Error('Missing tag');
      const renamed = await tag(s, 'tag.rename', first.tag.id, {
        key: 'ops-new',
        expectedTagRevision: 1,
      });
      expect(renamed.tag).toEqual({
        id: first.tag.id,
        key: 'ops-new',
        revision: 2,
      });
      await expect(
        tag(s, 'tag.rename', first.tag.id, {
          key: 'lost',
          expectedTagRevision: 1,
        }),
      ).rejects.toMatchObject({ code: 'P7006' });
      await expect(
        tag(s, 'tag.create', null, { key: 'different' }, key),
      ).rejects.toMatchObject({ code: 'P7002' });
    });

    it.each([
      'ops_2',
      '-ops',
      'ops--2',
      'équipe',
      '\tops\t',
      'ops\n',
      'x'.repeat(33),
      '',
    ])('rejects noncanonical tag input %j', async (key) => {
      const s = await fixture.scope();
      await expect(tag(s, 'tag.create', null, { key })).rejects.toMatchObject({
        code: '22023',
      });
      expect(
        (
          await owner(
            s,
            'select * from app.workflow_organization_receipts where workspace_id=$1',
            [s.workspace],
          )
        ).rows,
      ).toEqual([]);
    });

    it('canonicalizes tag selections, bounds sixteen, bumps no-ops once, and replays before current selection/writer', async () => {
      const s = await fixture.scope(),
        workflow = await s.workflow();
      const tags = await Promise.all(
        Array.from({ length: 17 }, (_, index) =>
          createTag(s, `tag-${String(index)}`),
        ),
      );
      await expect(
        assignment(
          s,
          workflow,
          tags.map(({ id }) => id),
        ),
      ).rejects.toMatchObject({ code: '22023' });
      await expect(
        assignment(s, workflow, [required(tags[0]).id, required(tags[0]).id]),
      ).rejects.toMatchObject({ code: '22023' });
      const key = commandKey(),
        selected = tags.slice(0, 16).map(({ id }) => id);
      expect(
        await assignment(s, workflow, [...selected].reverse(), 1, key),
      ).toMatchObject({
        organizationRevision: 2,
        tagIds: [...selected].sort(),
      });
      expect(await assignment(s, workflow, selected, 1, key)).toMatchObject({
        replayed: true,
        organizationRevision: 2,
      });
      await expect(assignment(s, workflow, [], 1)).rejects.toMatchObject({
        code: 'P7008',
      });
      expect(await assignment(s, workflow, selected, 2)).toMatchObject({
        organizationRevision: 3,
      });
      const deleted = required(tags[0]);
      await tag(s, 'tag.delete', deleted.id, { expectedTagRevision: 1 });
      await owner(
        s,
        'update app.workflow_organization_rollout set writes_enabled=false',
      );
      try {
        expect(await assignment(s, workflow, selected, 1, key)).toMatchObject({
          replayed: true,
          organizationRevision: 2,
        });
        await expect(assignment(s, workflow, [], 4)).rejects.toMatchObject({
          code: 'P7001',
        });
      } finally {
        await owner(
          s,
          'update app.workflow_organization_rollout set writes_enabled=true',
        );
      }
    });

    it('deletes exactly fifty assignments atomically; fifty-first conflicts without any revision mutation; archived cleanup works', async () => {
      const s = await fixture.scope(),
        t = await createTag(s);
      const workflows: string[] = [];
      for (let index = 0; index < 51; index++) {
        const id = await s.workflow(`Bounded workflow ${String(index)}`);
        workflows.push(id);
        await assignment(s, id, [t.id]);
      }
      const before = (
        await owner(
          s,
          'select workflow_id,revision::int revision from app.workflow_organization_state where workspace_id=$1 order by workflow_id',
          [s.workspace],
        )
      ).rows;
      await expect(
        tag(s, 'tag.delete', t.id, { expectedTagRevision: 1 }),
      ).rejects.toMatchObject({ code: 'P7007' });
      expect(
        (
          await owner(
            s,
            'select workflow_id,revision::int revision from app.workflow_organization_state where workspace_id=$1 order by workflow_id',
            [s.workspace],
          )
        ).rows,
      ).toEqual(before);
      expect(
        (
          await owner(
            s,
            'select count(*)::int count from app.workflow_tag_assignments where workspace_id=$1',
            [s.workspace],
          )
        ).rows,
      ).toEqual([{ count: 51 }]);
      const archived = required(workflows[0]);
      await fixture.authoring.transitionWorkflowLifecycle({
        workspaceId: s.workspace,
        actorId: s.actor,
        workflowId: archived,
        command: 'archive',
        expectedLifecycleRevision: 1,
        idempotencyKey: randomUUID(),
      });
      await expect(assignment(s, archived, [], 2)).rejects.toMatchObject({
        code: 'P7009',
      });
      const detached = await api(s, s.actor, (client) =>
        command(
          client,
          "select app.execute_workflow_tag_assignment_command('tag.detach',$1,$2,$3::jsonb) result",
          [
            archived,
            commandKey(),
            JSON.stringify({ tagId: t.id, expectedOrganizationRevision: 2 }),
          ],
        ),
      );
      expect(detached).toMatchObject({ organizationRevision: 3 });
      expect(
        await tag(s, 'tag.delete', t.id, { expectedTagRevision: 1 }),
      ).toMatchObject({ detachedWorkflowCount: 50 });
      expect(
        (
          await owner(
            s,
            'select revision::int revision from app.workflow_organization_state where workspace_id=$1',
            [s.workspace],
          )
        ).rows,
      ).toEqual(Array.from({ length: 51 }, () => ({ revision: 3 })));
      expect(
        (
          await owner(
            s,
            'select * from app.workflow_tag_assignments where workspace_id=$1',
            [s.workspace],
          )
        ).rows,
      ).toEqual([]);
    });

    it('checks current roles on processing/replay and sanitizes foreign workflow/tag IDs', async () => {
      const s = await fixture.scope(),
        other = await fixture.scope(),
        workflow = await s.workflow(),
        foreign = await other.workflow();
      const t = await createTag(s),
        foreignTag = await createTag(other);
      await expect(
        tag(s, 'tag.create', null, { key: 'denied' }, commandKey(), s.viewer),
      ).rejects.toMatchObject({ code: '42501' });
      await expect(
        tag(
          s,
          'tag.rename',
          t.id,
          { key: 'denied', expectedTagRevision: 1 },
          commandKey(),
          s.builder,
        ),
      ).rejects.toMatchObject({ code: '42501' });
      await expect(
        assignment(s, workflow, [t.id], 1, commandKey(), s.viewer),
      ).rejects.toMatchObject({ code: '42501' });
      expect(
        await assignment(s, workflow, [t.id], 1, commandKey(), s.builder),
      ).toMatchObject({ organizationRevision: 2 });
      await expect(
        assignment(s, workflow, [foreignTag.id], 2),
      ).rejects.toMatchObject({ code: 'P7005' });
      await expect(assignment(s, foreign, [])).rejects.toMatchObject({
        code: '42501',
      });
      const key = commandKey();
      await assignment(s, workflow, [], 2, key, s.builder);
      await owner(
        s,
        "update app.workspace_memberships set status='suspended' where workspace_id=$1 and user_id=$2",
        [s.workspace, s.builder],
      );
      await expect(
        assignment(s, workflow, [], 2, key, s.builder),
      ).rejects.toMatchObject({ code: '42501' });
    });

    it('serializes the workspace vocabulary cap of 256 and keeps other-workspace keys independent', async () => {
      const s = await fixture.scope(),
        other = await fixture.scope();
      for (let index = 0; index < 256; index++)
        await createTag(s, `quota-${String(index)}`);
      await expect(createTag(s, 'overflow')).rejects.toMatchObject({
        code: 'P7004',
      });
      expect(await createTag(other, 'quota-0')).toMatchObject({
        key: 'quota-0',
        revision: 1,
      });
      expect(
        (
          await owner(
            s,
            'select count(*)::int count from app.workflow_tags where workspace_id=$1',
            [s.workspace],
          )
        ).rows,
      ).toEqual([{ count: 256 }]);
    });

    it('supports viewer favorites and archived bookmarks, with actor-only state/receipts and no private audit', async () => {
      const s = await fixture.scope(),
        workflow = await s.workflow();
      await fixture.authoring.transitionWorkflowLifecycle({
        workspaceId: s.workspace,
        actorId: s.actor,
        workflowId: workflow,
        command: 'archive',
        expectedLifecycleRevision: 1,
        idempotencyKey: randomUUID(),
      });
      const proof = await absence(s, workflow);
      const first = await favorite(s, workflow, true, proof.token, proof);
      expect(first).toMatchObject({ isFavorite: true, replayed: false });
      expect(
        (
          await api(s, s.viewer, (client) =>
            client.query('select workflow_id from app.workflow_favorites'),
          )
        ).rows,
      ).toEqual([{ workflow_id: workflow }]);
      for (const table of ['workflow_favorites', 'workflow_favorite_receipts'])
        expect(
          (
            await api(s, s.actor, (client) =>
              client.query(`select * from app.${table}`),
            )
          ).rows,
        ).toEqual([]);
      expect(
        (
          await owner(
            s,
            "select * from app.audit_events where workspace_id=$1 and action like '%favorite%'",
            [s.workspace],
          )
        ).rows,
      ).toEqual([]);
      expect(
        (
          await owner(
            s,
            "select * from app.idempotency_records where workspace_id=$1 and operation like '%favorite%'",
            [s.workspace],
          )
        ).rows,
      ).toEqual([]);
    });

    it('retains suspension state but invalidates departure/rejoin, old receipts and never-recorded internal generation proof without ABA', async () => {
      const s = await fixture.scope(),
        workflow = await s.workflow(),
        key = commandKey();
      const proof = await absence(s, workflow);
      const first = await favorite(s, workflow, true, proof.token, proof, key);
      await owner(
        s,
        "update app.workspace_memberships set status='suspended' where workspace_id=$1 and user_id=$2",
        [s.workspace, s.viewer],
      );
      expect(
        (
          await api(s, s.viewer, (client) =>
            client.query('select * from app.workflow_favorites'),
          )
        ).rows,
      ).toEqual([]);
      await expect(
        favorite(s, workflow, true, proof.token, proof, key),
      ).rejects.toMatchObject({ code: '42501' });
      await owner(
        s,
        "update app.workspace_memberships set status='active' where workspace_id=$1 and user_id=$2",
        [s.workspace, s.viewer],
      );
      expect((await absence(s, workflow)).generation).toBe(proof.generation);
      expect(
        await favorite(s, workflow, true, proof.token, proof, key),
      ).toEqual({ ...first, replayed: true });
      await removeAndRejoin(s);
      const current = await absence(s, workflow);
      expect(current.generation).not.toBe(proof.generation);
      expect(
        (
          await api(s, s.viewer, (client) =>
            client.query('select * from app.workflow_favorites'),
          )
        ).rows,
      ).toEqual([]);
      await expect(
        favorite(s, workflow, true, proof.token, proof, key),
      ).rejects.toMatchObject({ code: '42501' });
      await expect(
        favorite(s, workflow, true, proof.token, proof),
      ).rejects.toMatchObject({ code: 'P7010' });
      await expect(
        favorite(s, workflow, false, required(first.favoriteRevision)),
      ).rejects.toMatchObject({ code: 'P7010' });
      expect(
        await favorite(s, workflow, false, current.token, current),
      ).toMatchObject({ isFavorite: false });
      // Restrictive lifetime FK cannot silently discard retained generation/state.
      await expect(
        owner(
          s,
          'delete from app.workspace_memberships where workspace_id=$1 and user_id=$2',
          [s.workspace, s.viewer],
        ),
      ).rejects.toMatchObject({ code: '23503' });
    });

    it('keeps one false tombstone for 24h, rejects stale token writes, and exact replay does not renew expiry or require writer/proof', async () => {
      const s = await fixture.scope(),
        workflow = await s.workflow(),
        proof = await absence(s, workflow),
        key = commandKey();
      const first = await favorite(s, workflow, false, proof.token, proof, key);
      await expect(
        favorite(s, workflow, true, proof.token, proof, key),
      ).rejects.toMatchObject({ code: 'P7002' });
      const before = (
        await owner(
          s,
          'select expires_at from app.workflow_favorites where workspace_id=$1',
          [s.workspace],
        )
      ).rows;
      expect(
        await favorite(s, workflow, false, proof.token, undefined, key),
      ).toEqual({ ...first, replayed: true });
      expect(
        (
          await owner(
            s,
            'select expires_at from app.workflow_favorites where workspace_id=$1',
            [s.workspace],
          )
        ).rows,
      ).toEqual(before);
      expect(
        (
          await owner(
            s,
            "select expires_at between clock_timestamp()+interval '23 hours 59 minutes' and clock_timestamp()+interval '24 hours 1 minute' valid from app.workflow_favorites where workspace_id=$1",
            [s.workspace],
          )
        ).rows,
      ).toEqual([{ valid: true }]);
      await expect(
        favorite(s, workflow, true, proof.token, proof),
      ).rejects.toMatchObject({ code: 'P7010' });
      const next = await favorite(
        s,
        workflow,
        true,
        required(first.favoriteRevision),
      );
      await expect(
        favorite(s, workflow, false, required(first.favoriteRevision)),
      ).rejects.toMatchObject({ code: 'P7010' });
      const last = await favorite(
        s,
        workflow,
        false,
        required(next.favoriteRevision),
      );
      expect(last.favoriteRevision).not.toBe(first.favoriteRevision);
      expect(
        (
          await owner(
            s,
            'select count(*)::int count from app.workflow_favorites where workspace_id=$1',
            [s.workspace],
          )
        ).rows,
      ).toEqual([{ count: 1 }]);
      await owner(
        s,
        'update app.workflow_organization_rollout set writes_enabled=false',
      );
      await owner(
        s,
        "update app.workflow_favorite_receipts set created_at=clock_timestamp()-interval '2 days',expires_at=clock_timestamp()-interval '1 second' where workspace_id=$1 and key_hash=$2",
        [s.workspace, key],
      );
      try {
        expect(
          await favorite(s, workflow, false, proof.token, undefined, key),
        ).toEqual({ ...first, replayed: true });
        await expect(
          favorite(s, workflow, true, required(last.favoriteRevision)),
        ).rejects.toMatchObject({ code: 'P7001' });
      } finally {
        await owner(
          s,
          'update app.workflow_organization_rollout set writes_enabled=true',
        );
      }
      // Replay preserved the current later state; neither old nor new row expiry is extended.
      expect(
        (
          await owner(
            s,
            'select favorite,revision from app.workflow_favorites where workspace_id=$1',
            [s.workspace],
          )
        ).rows,
      ).toEqual([{ favorite: false, revision: last.favoriteRevision }]);
      expect(before).toHaveLength(1);
    });

    it.each([
      'expired',
      'future',
      'wrong-generation',
      'wrong-ttl',
      'literal-absent',
    ] as const)(
      'checks SQL absence precondition %s and rolls back unfinished claims',
      async (kind) => {
        const s = await fixture.scope(),
          workflow = await s.workflow(),
          snapshot = await absence(s, workflow),
          key = commandKey();
        const proof = absenceBody(
          s,
          workflow,
          kind === 'wrong-generation' ? randomUUID() : snapshot.generation,
          snapshot.issued +
            (kind === 'expired' ? -86401 : kind === 'future' ? 60 : 0),
        );
        if (kind === 'wrong-ttl') proof.expires++;
        await expect(
          favorite(
            s,
            workflow,
            true,
            kind === 'literal-absent' ? 'absent' : proof.token,
            proof,
            key,
          ),
        ).rejects.toMatchObject({
          code: kind === 'literal-absent' ? '22023' : 'P7010',
        });
        expect(
          (
            await owner(
              s,
              'select * from app.workflow_favorite_receipts where workspace_id=$1 and key_hash=$2',
              [s.workspace, key],
            )
          ).rows,
        ).toEqual([]);
      },
    );

    it('denies raw mutations, held evidence access, worker/dispatcher execution and missing tenant scope', async () => {
      const s = await fixture.scope(),
        workflow = await s.workflow(),
        t = await createTag(s);
      for (const selected of [fixture.worker, fixture.dispatcher]) {
        await expect(
          selected.query('select * from app.workflow_favorites'),
        ).rejects.toMatchObject({ code: '42501' });
        await expect(
          selected.query(
            'select app.execute_workflow_tag_command($1,null,$2,$3)',
            ['tag.create', commandKey(), JSON.stringify({ key: 'worker' })],
          ),
        ).rejects.toMatchObject({ code: '42501' });
      }
      for (const statement of [
        "update app.workflow_tags set key='forged' where id=$1",
        'delete from app.workflow_tag_assignments where tag_id=$1',
        'select * from app.workflow_favorite_held_evidence',
        'select app.reap_workflow_organization(1)',
      ])
        await expect(
          api(s, s.actor, (client) =>
            client.query(statement, statement.includes('$1') ? [t.id] : []),
          ),
        ).rejects.toMatchObject({ code: '42501' });
      await expect(
        fixture.api.query('select app.read_workflow_favorite_generation()'),
      ).rejects.toMatchObject({ code: '42501' });
      const other = await fixture.scope(),
        foreign = await other.workflow(),
        proof = await absence(s, workflow);
      await expect(
        favorite(s, foreign, true, proof.token, proof),
      ).rejects.toMatchObject({ code: '42501' });
      expect(
        (
          await api(s, other.actor, (client) =>
            client.query('select * from app.workflow_tags'),
          )
        ).rows,
      ).toEqual([]);
    });

    it('serializes competing tag replacements with one revision winner, without lost assignments', async () => {
      const s = await fixture.scope(),
        workflow = await s.workflow(),
        firstTag = await createTag(s),
        secondTag = await createTag(s);
      const first = await fixture.api.connect(),
        second = await fixture.api.connect();
      let pending: Promise<{ result?: Result; error?: unknown }> | undefined;
      try {
        const firstPid = await begin(first, s, s.builder),
          secondPid = await begin(second, s, s.builder);
        const statement =
          "select app.execute_workflow_tag_assignment_command('tags.replace',$1,$2,$3::jsonb) result";
        await command(first, statement, [
          workflow,
          commandKey(),
          JSON.stringify({
            tagIds: [firstTag.id],
            expectedOrganizationRevision: 1,
          }),
        ]);
        pending = command(second, statement, [
          workflow,
          commandKey(),
          JSON.stringify({
            tagIds: [secondTag.id],
            expectedOrganizationRevision: 1,
          }),
        ]).then(
          (result) => ({ result }),
          (error: unknown) => ({ error }),
        );
        await fixture.waitForBlocker(firstPid, secondPid);
        await first.query('commit');
        expect((await pending).error).toMatchObject({ code: 'P7008' });
      } finally {
        await rollbackRelease(first);
        await pending;
        await rollbackRelease(second);
      }
      expect(
        (
          await owner(
            s,
            'select tag_id from app.workflow_tag_assignments where workspace_id=$1 and workflow_id=$2',
            [s.workspace, workflow],
          )
        ).rows,
      ).toEqual([{ tag_id: firstTag.id }]);
    });

    it('membership removal wins before a queued favorite write; locked authority denies rather than resurrecting private state', async () => {
      const s = await fixture.scope(),
        workflow = await s.workflow(),
        proof = await absence(s, workflow);
      const removal = await fixture.owner.connect(),
        writer = await fixture.api.connect();
      let pending: Promise<{ result?: Result; error?: unknown }> | undefined;
      try {
        const removalPid = await begin(removal, s, s.actor, true),
          writerPid = await begin(writer, s, s.viewer);
        await removal.query(
          'select id from app.workspaces where id=$1 for update',
          [s.workspace],
        );
        await removal.query(
          "update app.workspace_memberships set status='removed',role_revision=role_revision+1 where workspace_id=$1 and user_id=$2",
          [s.workspace, s.viewer],
        );
        pending = favoriteOn(writer, workflow, true, proof.token, proof).then(
          (result) => ({ result }),
          (error: unknown) => ({ error }),
        );
        await fixture.waitForBlocker(removalPid, writerPid);
        await removal.query('commit');
        expect((await pending).error).toMatchObject({ code: '42501' });
      } finally {
        await rollbackRelease(removal);
        await pending;
        await rollbackRelease(writer);
      }
      expect(
        (
          await owner(
            s,
            'select * from app.workflow_favorites where workspace_id=$1',
            [s.workspace],
          )
        ).rows,
      ).toEqual([]);
      expect(
        (
          await owner(
            s,
            'select * from app.workflow_favorite_receipts where workspace_id=$1',
            [s.workspace],
          )
        ).rows,
      ).toEqual([]);
    });

    it('bounds total cleanup work and preserves unexpired tombstones', async () => {
      const s = await fixture.scope(),
        workflow = await s.workflow(),
        proof = await absence(s, workflow);
      await favorite(s, workflow, false, proof.token, proof);
      await reap(1);
      expect(
        (
          await owner(
            s,
            'select favorite from app.workflow_favorites where workspace_id=$1',
            [s.workspace],
          )
        ).rows,
      ).toEqual([{ favorite: false }]);
      await owner(
        s,
        "update app.workflow_favorites set expires_at=clock_timestamp()-interval '1 second' where workspace_id=$1",
        [s.workspace],
      );
      for (let index = 0; index < 40; index++) {
        const counts = await reap(2);
        expect(
          Object.values(counts).reduce((a, b) => a + b, 0),
        ).toBeLessThanOrEqual(2);
        if (Object.values(counts).every((count) => count === 0)) break;
      }
      expect(
        (
          await owner(
            s,
            'select * from app.workflow_favorites where workspace_id=$1',
            [s.workspace],
          )
        ).rows,
      ).toEqual([]);
      await expect(reap(101)).rejects.toMatchObject({ code: '22023' });
    });

    it('purges organization children in bounded maintenance pages only after lease and high-water authorization', async () => {
      const s = await fixture.scope(),
        workflow = await s.workflow(),
        t = await createTag(s),
        old = await absence(s, workflow);
      await assignment(s, workflow, [t.id]);
      const folders: string[] = [];
      for (const name of ['root', 'child', 'leaf']) {
        const created = await api(s, s.actor, (client) =>
          client.query<{ result: { folder: { id: string } } }>(
            "select app.execute_workflow_folder_command('folder.create',null,$1,$2::jsonb) result",
            [
              commandKey(),
              JSON.stringify({ name, parentId: folders.at(-1) ?? null }),
            ],
          ),
        );
        folders.push(required(created.rows[0]).result.folder.id);
      }
      await api(s, s.actor, (client) =>
        client.query(
          'select app.execute_workflow_folder_placement($1,$2,$3::jsonb)',
          [
            workflow,
            commandKey(),
            JSON.stringify({
              folderId: folders.at(-1),
              expectedOrganizationRevision: 2,
            }),
          ],
        ),
      );
      await api(s, s.actor, (client) =>
        client.query(
          'select app.admit_workflow_organization_batch($1,$2::jsonb)',
          [
            commandKey(),
            JSON.stringify({
              operation: 'move',
              folderId: null,
              items: [
                { workflowId: workflow, expectedOrganizationRevision: 3 },
              ],
            }),
          ],
        ),
      );
      await favorite(s, workflow, true, old.token, old);
      await removeAndRejoin(s);
      const fresh = await absence(s, workflow);
      await favorite(s, workflow, false, fresh.token, fresh);
      const job = randomUUID(),
        lease = randomUUID();
      const anchor = required(
        (
          await owner(
            s,
            'select retention_control_sequence::int sequence,retention_control_hash hash from app.workspaces where id=$1',
            [s.workspace],
          )
        ).rows[0],
      );
      // Privileged disposable fixture supplies the existing purge owner's
      // prepared state. This proves SQL bounded-page enforcement, not object
      // ledger or full workspace-deletion transport qualification.
      await fixture.transaction(
        fixture.owner,
        s.workspace,
        s.actor,
        async (client) => {
          await client.query(
            "select set_config('app.workspace_purge_transition','on',true)",
          );
          await client.query(
            `update app.workspaces set status='purging',deletion_requested_at=clock_timestamp()-interval '31 days',
          deletion_requested_by=$2,deletion_reason='owned purge fixture',purge_after=clock_timestamp()-interval '1 day' where id=$1`,
            [s.workspace, s.actor],
          );
          await client.query(
            `insert into app.workspace_purge_jobs(id,workspace_id,command_id,actor_ref,reason,occurred_at,status,control_sequence,control_record_hash)
          values($1,$2,$3,'owned-fixture','F07 bounded page',clock_timestamp(),'purging',$4,$5)`,
            [job, s.workspace, randomUUID(), anchor.sequence, anchor.hash],
          );
          await client.query(
            `insert into app.workspace_purge_steps(job_id,step_name,status,lease_owner,lease_token,lease_fence,lease_acquired_at,lease_expires_at)
          values($1,'tenant_rows','running','owned-fixture',$2,1,clock_timestamp(),clock_timestamp()+interval '2 minutes')`,
            [job, lease],
          );
        },
      );
      async function page(token = lease, hash: unknown = anchor.hash) {
        return fixture.transaction(
          fixture.maintenance,
          s.workspace,
          s.actor,
          async (client) => {
            await client.query(
              'select pg_advisory_xact_lock(hashtextextended($1,1934781127))',
              [s.workspace],
            );
            await client.query(
              'select * from app.lock_workspace_control_ledger($1)',
              [s.workspace],
            );
            return client.query<{
              surface: string;
              affected_count: number;
              completed: boolean;
            }>(
              'select * from app.execute_workspace_tenant_rows_page($1,$2,1,2,$3,$4)',
              [job, token, anchor.sequence, hash],
            );
          },
        );
      }
      await expect(page(randomUUID())).rejects.toMatchObject({ code: '55000' });
      await expect(page(lease, 'f'.repeat(64))).rejects.toMatchObject({
        code: '40001',
      });
      expect(
        (
          await owner(
            s,
            'select count(*)::int count from app.workflow_favorite_held_evidence where workspace_id=$1',
            [s.workspace],
          )
        ).rows,
      ).toEqual([{ count: 1 }]);
      const surfaces = [
        'workflow_favorite_receipts',
        'workflow_favorite_held_evidence',
        'workflow_favorites',
        'workflow_organization_receipts',
        'workflow_tag_assignments',
        'workflow_organization_state',
        'workflow_folders',
        'workflow_tags',
        'workflow_favorite_membership_generations',
        'workflow_organization_coordination',
      ];
      const seen = new Set<string>();
      for (let index = 0; index < 30; index++) {
        await fixture.transaction(
          fixture.owner,
          s.workspace,
          s.actor,
          async (client) => {
            await client.query(
              "select set_config('app.workspace_purge_transition','on',true)",
            );
            await client.query(
              "update app.workspace_purge_steps set status='running',lease_owner='owned-fixture',lease_token=$2,lease_fence=1,lease_acquired_at=clock_timestamp(),lease_expires_at=clock_timestamp()+interval '2 minutes' where job_id=$1 and step_name='tenant_rows'",
              [job, lease],
            );
          },
        );
        const result = required((await page()).rows[0]);
        expect(result.affected_count).toBeGreaterThan(0);
        expect(result.affected_count).toBeLessThanOrEqual(2);
        expect(result.completed).toBe(false);
        expect(surfaces).toContain(result.surface);
        seen.add(result.surface);
        const remaining = await owner(
          s,
          `select ${surfaces.map((table) => `(select count(*) from app.${table} where workspace_id=$1)`).join('+')} count`,
          [s.workspace],
        );
        if (remaining.rows[0]?.count === '0') break;
      }
      expect([...seen].sort()).toEqual([...surfaces].sort());
      expect(
        (
          await owner(s, 'select id from app.workflows where workspace_id=$1', [
            s.workspace,
          ])
        ).rows,
      ).toEqual([{ id: workflow }]);
    });
  },
);
