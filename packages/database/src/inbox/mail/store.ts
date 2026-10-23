import { WorkspaceAccessDeniedError } from '../../tenant-access/errors.js';
import type { PoolClient } from 'pg';
import type { NoticeSchedule } from '@pertexo/contracts';
import type { DatabaseConfig } from '../../config.js';
import {
  acquireDatabasePool,
  type DatabaseRuntime,
} from '../../platform/pool/runtime.js';
import { insertSystemMail } from '../../platform/mail/store.js';
import { generatePersistedId } from '../../platform/persisted-id.js';
import { withTenantScopedClient } from '../../tenant-access/transactions.js';
import { lockWorkspaceAuthority } from '../../tenant-access/workspaces/authority.js';
import { rolesForCapability } from '@pertexo/workflow-model';
import {
  projectNoticePreferences,
  type DefaultsRow,
  type PreferenceRow,
} from '../preferences/read.js';
import { noticeWindow, nextNoticeDue } from './schedule.js';
import { readMailSubjects, mailItem } from './subjects.js';
import type { NoticeMailStore, NoticeMailSealer } from './contract.js';
type Person = Readonly<{ workspace_id: string; user_id: string }>;
type Recipient = Readonly<{
  email: string;
  workspace_name: string;
  email_verified: boolean;
  role_revision: number;
  created_at: Date;
  now: Date;
}>;
async function recipient(
  client: PoolClient,
  workspaceId: string,
  actorId: string,
): Promise<Recipient | undefined> {
  const found = await client.query<Recipient>(
    "select person.email,workspace.name workspace_name,person.email_verified,member.role_revision,member.created_at,clock_timestamp() now from app.users person join app.workspace_memberships member on member.user_id=person.id join app.workspaces workspace on workspace.id=member.workspace_id where member.workspace_id=$1 and member.user_id=$2 and member.status='active' and person.status='active' for share of person,member",
    [workspaceId, actorId],
  );
  return found.rows[0];
}
async function settings(
  client: PoolClient,
  workspaceId: string,
  actorId: string,
  { create }: Readonly<{ create: boolean }>,
) {
  const defs = await client.query<DefaultsRow>(
    'select * from app.notice_workspace_settings where workspace_id=$1 for share',
    [workspaceId],
  );
  if (create)
    await client.query(
      'insert into app.notice_preferences(workspace_id,user_id) values($1,$2) on conflict do nothing',
      [workspaceId, actorId],
    );
  const prefs = await client.query<PreferenceRow>(
    'select * from app.notice_preferences where workspace_id=$1 and user_id=$2 for update',
    [workspaceId, actorId],
  );
  const pref = prefs.rows[0];
  const defaults = defs.rows[0];
  const projected = projectNoticePreferences(pref, defaults, {
    canManageDefaults: false,
    emailAvailable: true,
  });
  const cut = new Date(
    Math.max(
      pref?.revision === 0 ? 0 : (pref?.changed_at.getTime() ?? 0),
      pref?.mode === null ? (defaults?.changed_at.getTime() ?? 0) : 0,
    ),
  );
  return {
    pref,
    defaults,
    effective: projected.effective,
    cut,
    defaultRevision: pref?.mode === null ? projected.defaults.revision : 0,
  };
}
async function advance(
  client: PoolClient,
  workspaceId: string,
  {
    actorId,
    schedule,
    now,
    defaultRevision,
  }: Readonly<{
    actorId: string;
    schedule: NoticeSchedule;
    now: Date;
    defaultRevision: number;
  }>,
) {
  await client.query(
    'update app.notice_preferences set next_due_at=$3,schedule_default_revision=$4 where workspace_id=$1 and user_id=$2',
    [workspaceId, actorId, nextNoticeDue(schedule, now), defaultRevision],
  );
}
async function preparePerson(
  client: PoolClient,
  person: Person,
  seal: NoticeMailSealer,
): Promise<number> {
  await lockWorkspaceAuthority(
    client,
    person.workspace_id,
    person.user_id,
    rolesForCapability('workspace:read'),
  );
  const to = await recipient(client, person.workspace_id, person.user_id);
  if (!to?.email_verified) return 0;
  const current = await settings(client, person.workspace_id, person.user_id, {
    create: true,
  });
  const pref = current.pref;
  if (pref === undefined || current.effective.mode === 'off') return 0;
  await client.query(
    `update app.notice_mail_batches batch set released_at=clock_timestamp() from app.system_mail_deliveries delivery where batch.id=delivery.id and batch.workspace_id=$1 and batch.user_id=$2 and batch.released_at is null and delivery.status='failed' and delivery.failure_code='notice.superseded'`,
    [person.workspace_id, person.user_id],
  );
  const pending = await client.query(
    `select 1 from app.notice_mail_batches batch join app.system_mail_deliveries delivery on delivery.id=batch.id where batch.workspace_id=$1 and batch.user_id=$2 and batch.released_at is null and delivery.status in ('queued','retry','outcome_unknown') limit 1`,
    [person.workspace_id, person.user_id],
  );
  if (pending.rowCount !== 0) return 0;
  const due = nextPersonNoticeDue(pref, current);
  if (due === null) return 0;
  if (due > to.now) {
    await client.query(
      'update app.notice_preferences set next_due_at=$3,schedule_default_revision=$4 where workspace_id=$1 and user_id=$2',
      [person.workspace_id, person.user_id, due, current.defaultRevision],
    );
    return 0;
  }
  const window = noticeWindow(current.effective, to.now);
  const reserved = await client.query(
    'select 1 from app.notice_mail_batches where workspace_id=$1 and user_id=$2 and window_key=$3 and released_at is null',
    [person.workspace_id, person.user_id, window],
  );
  if (reserved.rowCount !== 0) {
    await advance(client, person.workspace_id, {
      actorId: person.user_id,
      schedule: current.effective,
      now: to.now,
      defaultRevision: current.defaultRevision,
    });
    return 0;
  }
  const subjects = await readMailSubjects(client, person.workspace_id, {
    actorId: person.user_id,
    cut: new Date(Math.max(current.cut.getTime(), to.created_at.getTime())),
  });
  if (subjects.length === 0 && current.effective.mode === 'immediate') {
    await client.query(
      'update app.notice_preferences set next_due_at=$3,schedule_default_revision=$4 where workspace_id=$1 and user_id=$2',
      [person.workspace_id, person.user_id, to.now, current.defaultRevision],
    );
    return 0;
  }
  await advance(client, person.workspace_id, {
    actorId: person.user_id,
    schedule: current.effective,
    now: to.now,
    defaultRevision: current.defaultRevision,
  });
  if (subjects.length === 0) return 0;
  const id = generatePersistedId();
  const expiresAt = new Date(to.now.getTime() + 24 * 3_600_000);
  const sealedPayload = seal({
    id,
    expiresAt,
    toEmail: to.email,
    workspaceName: to.workspace_name,
    workspaceId: person.workspace_id,
    actorId: person.user_id,
    revision: pref.revision,
    memberRevision: to.role_revision,
    items: subjects.map(mailItem),
  });
  await insertSystemMail(client, {
    id,
    purpose: 'workspace_notice',
    expiresAt,
    sealedPayload,
  });
  await client.query(
    'insert into app.notice_mail_batches(id,workspace_id,user_id,preference_revision,default_revision,member_revision,recipient,window_key,item_count) values($1,$2,$3,$4,$5,$6,$7,$8,$9)',
    [
      id,
      person.workspace_id,
      person.user_id,
      pref.revision,
      current.defaultRevision,
      to.role_revision,
      to.email,
      window,
      subjects.length,
    ],
  );
  await client.query(
    'insert into app.notice_mail_items(workspace_id,batch_id,thread_id,revision) select $1,$2,item.id,item.revision from jsonb_to_recordset($3::jsonb) as item(id uuid,revision bigint)',
    [
      person.workspace_id,
      id,
      JSON.stringify(
        subjects.map((row) => ({ id: row.id, revision: row.revision })),
      ),
    ],
  );
  return 1;
}
async function authorizeBatch(
  client: PoolClient,
  workspaceId: string,
  actorId: string,
  deliveryId: string,
): Promise<boolean> {
  const found = await client.query<{
    preference_revision: number;
    default_revision: number;
    member_revision: number;
    recipient: string;
    item_count: number;
    released_at: Date | null;
  }>(
    'select * from app.notice_mail_batches where workspace_id=$1 and user_id=$2 and id=$3',
    [workspaceId, actorId, deliveryId],
  );
  const batch = found.rows[0];
  if (batch?.released_at !== null) return false;
  const to = await recipient(client, workspaceId, actorId);
  if (
    !to?.email_verified ||
    to.email !== batch.recipient ||
    to.role_revision !== batch.member_revision
  )
    return false;
  const current = await settings(client, workspaceId, actorId, {
    create: false,
  });
  if (
    current.pref?.revision !== batch.preference_revision ||
    current.defaultRevision !== batch.default_revision ||
    current.effective.mode === 'off'
  )
    return false;
  const items = await client.query<{ thread_id: string }>(
    'select thread_id from app.notice_mail_items where workspace_id=$1 and batch_id=$2',
    [workspaceId, deliveryId],
  );
  if (items.rows.length !== batch.item_count) return false;
  const subjects = await readMailSubjects(client, workspaceId, {
    actorId,
    cut: new Date(Math.max(current.cut.getTime(), to.created_at.getTime())),
    onlyIds: items.rows.map((row) => row.thread_id),
  });
  return subjects.length === batch.item_count;
}
export function createNoticeMailStore(
  config: DatabaseConfig,
  maintenanceConfig: DatabaseConfig,
  seal: NoticeMailSealer,
  runtime?: DatabaseRuntime,
): NoticeMailStore {
  const lease = acquireDatabasePool(config, runtime);
  const maintenance = acquireDatabasePool(maintenanceConfig);
  let after: Person | undefined;
  return {
    close: async () => {
      await lease.close();
      await maintenance.close();
    },
    prepare: async (signal) => {
      signal?.throwIfAborted();
      const candidates = await maintenance.pool.query<Person>(
        `select member.workspace_id,member.user_id from app.workspace_memberships member join app.workspaces workspace on workspace.id=member.workspace_id left join app.notice_preferences pref on pref.workspace_id=member.workspace_id and pref.user_id=member.user_id left join app.notice_workspace_settings defaults on defaults.workspace_id=member.workspace_id where member.status='active' and workspace.status='active' and coalesce(pref.mode,defaults.mode,'off')<>'off' and (pref.next_due_at is null or pref.next_due_at<=clock_timestamp() or (pref.mode is null and pref.schedule_default_revision<>coalesce(defaults.revision,0))) and ($1::uuid is null or (member.workspace_id,member.user_id)>($1::uuid,$2::uuid)) order by member.workspace_id,member.user_id limit 10`,
        [after?.workspace_id ?? null, after?.user_id ?? null],
      );
      let count = 0;
      for (const person of candidates.rows) {
        signal?.throwIfAborted();
        try {
          count += await withTenantScopedClient(
            lease.pool,
            { workspaceId: person.workspace_id, actorId: person.user_id },
            (client) => preparePerson(client, person, seal),
            {
              statementTimeoutMillis: 5000,
              ...(signal === undefined ? {} : { signal }),
            },
          );
        } catch (error) {
          if (!(error instanceof WorkspaceAccessDeniedError)) throw error;
        }
        after = person;
      }
      if (candidates.rows.length < 10) after = undefined;
      return count;
    },
    authorize: async (deliveryId) => {
      const context = await maintenance.pool.query<Person>(
        'select workspace_id,user_id from app.notice_mail_batches where id=$1',
        [deliveryId],
      );
      const person = context.rows[0];
      if (person === undefined) return false;
      try {
        return await withTenantScopedClient(
          lease.pool,
          { workspaceId: person.workspace_id, actorId: person.user_id },
          async (client) => {
            await lockWorkspaceAuthority(
              client,
              person.workspace_id,
              person.user_id,
              rolesForCapability('workspace:read'),
            );
            return authorizeBatch(
              client,
              person.workspace_id,
              person.user_id,
              deliveryId,
            );
          },
          { statementTimeoutMillis: 5000 },
        );
      } catch (error) {
        if (error instanceof WorkspaceAccessDeniedError) return false;
        throw error;
      }
    },
  };
}

function nextPersonNoticeDue(
  pref: PreferenceRow,
  current: Awaited<ReturnType<typeof settings>>,
): Date | null {
  if (
    pref.next_due_at !== null &&
    pref.schedule_default_revision === current.defaultRevision
  ) {
    return pref.next_due_at;
  }
  if (current.effective.mode === 'immediate') {
    return current.cut;
  }
  return nextNoticeDue(current.effective, current.cut);
}
