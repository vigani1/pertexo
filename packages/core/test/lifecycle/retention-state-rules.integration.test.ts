import { randomUUID } from 'node:crypto';

import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  adminUrl,
  retention,
  userId,
  withDatabase,
  workspaceId,
} from './retention.support.js';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const MINUTE = 60_000;
const ago = (millis: number) => new Date(Date.now() - millis);
const hex = () => randomUUID().replaceAll('-', '').padEnd(64, '0');

let admin!: Client;

beforeAll(async () => {
  admin = new Client({ connectionString: withDatabase(adminUrl) });
  await admin.connect();
  await admin.query("select set_config('app.workspace_id', $1, false)", [
    workspaceId,
  ]);
  await admin.query(
    `insert into app.workspace_memberships(workspace_id,user_id,role)
     values($1,$2,'owner')`,
    [workspaceId, userId],
  );
});

afterAll(async () => {
  await admin.end();
});

async function untilIdle(): Promise<void> {
  for (let pass = 0; pass < 100; pass += 1)
    if (!(await retention.enforce()).more) return;
  throw new Error('Retention did not become idle');
}

describe('unsent system mail', () => {
  async function queued(fields: {
    createdAt?: Date;
    expiresAt?: Date;
    attemptCount?: number;
    leaseUntil?: Date;
  }): Promise<string> {
    const id = randomUUID();
    const lease = fields.leaseUntil;
    await admin.query(
      `insert into app.system_mail_deliveries
        (id,purpose,status,expires_at,created_at,attempt_count,
         payload_ciphertext,payload_nonce,payload_tag,payload_key_version,
         lease_owner,lease_token,lease_expires_at)
       values($1,'verification',$2,$3,$4,$5,'sealed','nonce','tag','v1',$6,$7,$8)`,
      [
        id,
        lease === undefined ? 'queued' : 'outcome_unknown',
        fields.expiresAt ?? new Date(Date.now() + 7 * DAY),
        fields.createdAt ?? new Date(),
        fields.attemptCount ?? 0,
        lease === undefined ? null : 'worker',
        lease === undefined ? null : randomUUID(),
        lease ?? null,
      ],
    );
    return id;
  }

  async function mail(id: string) {
    const result = await admin.query<{
      status: string;
      payload_ciphertext: string | null;
    }>(
      'select status,payload_ciphertext from app.system_mail_deliveries where id=$1',
      [id],
    );
    return result.rows[0];
  }

  it('gives up a mail a minute past 24 hours and drops its payload', async () => {
    const id = await queued({ createdAt: ago(DAY + MINUTE) });

    await untilIdle();

    expect(await mail(id)).toEqual({
      status: 'reconciliation_required',
      payload_ciphertext: null,
    });
  });

  it('keeps a mail a minute inside 24 hours', async () => {
    const id = await queued({ createdAt: ago(DAY - MINUTE) });

    await untilIdle();

    expect(await mail(id)).toEqual({
      status: 'queued',
      payload_ciphertext: 'sealed',
    });
  });

  it('gives up at twelve attempts and keeps eleven', async () => {
    const twelve = await queued({ attemptCount: 12 });
    const eleven = await queued({ attemptCount: 11 });

    await untilIdle();

    expect((await mail(twelve))?.status).toBe('reconciliation_required');
    expect((await mail(eleven))?.status).toBe('queued');
  });

  it('calls one past its own expiry expired', async () => {
    const id = await queued({
      createdAt: ago(2 * HOUR),
      expiresAt: ago(HOUR),
    });

    await untilIdle();

    expect(await mail(id)).toEqual({
      status: 'expired',
      payload_ciphertext: null,
    });
  });

  it('leaves one a worker still holds, however old', async () => {
    const id = await queued({
      createdAt: ago(2 * DAY),
      leaseUntil: new Date(Date.now() + MINUTE),
    });

    await untilIdle();

    expect((await mail(id))?.status).toBe('outcome_unknown');
  });
});

describe('expired invitations', () => {
  async function invitation(expiresAt: Date): Promise<string> {
    const id = randomUUID();
    const email = `${id}@example.test`;
    await admin.query(
      `insert into app.workspace_invitations
        (id,workspace_id,recipient_email,normalized_email,role,token_digest,
         created_by,expires_at,created_at)
       values($1,$2,$3,$3,'viewer',$4,$5,$6,$7)`,
      [id, workspaceId, email, hex(), userId, expiresAt, ago(2 * DAY)],
    );
    return id;
  }
  const statusOf = async (id: string) =>
    (
      await admin.query<{ status: string }>(
        'select status from app.workspace_invitations where id=$1',
        [id],
      )
    ).rows[0]?.status;

  it('moves one a minute past its time, a page at a time, and keeps one a minute inside', async () => {
    const past = [
      await invitation(ago(MINUTE)),
      await invitation(ago(MINUTE)),
      await invitation(ago(MINUTE)),
    ];
    const inside = await invitation(new Date(Date.now() + MINUTE));

    const first = await retention.enforce();
    expect(first.removed.invitation_expiry).toBe(2);
    expect(first.more).toBe(true);

    await untilIdle();
    for (const id of past) expect(await statusOf(id)).toBe('expired');
    expect(await statusOf(inside)).toBe('pending');
  });
});

describe('api tokens', () => {
  async function token(expiresAt: Date, revokedAt?: Date): Promise<string> {
    const id = randomUUID();
    await admin.query(
      `insert into app.api_tokens
        (id,workspace_id,owner_user_id,name,secret_digest,scopes,membership_revision,
         expires_at,revoked_at,created_at)
       values($1,$2,$3,'Token',$4,'["run:read"]',1,$5,$6,$7)`,
      [
        id,
        workspaceId,
        userId,
        hex(),
        expiresAt,
        revokedAt ?? null,
        new Date(expiresAt.getTime() - DAY),
      ],
    );
    return id;
  }
  const exists = async (id: string) =>
    (await admin.query('select 1 from app.api_tokens where id=$1', [id]))
      .rowCount === 1;

  it('takes one expired or revoked a minute past 30 days and keeps one inside', async () => {
    const expired = await token(ago(30 * DAY + MINUTE));
    const revoked = await token(
      new Date(Date.now() + DAY),
      ago(30 * DAY + MINUTE),
    );
    const inside = await token(ago(30 * DAY - MINUTE));
    const revokedInside = await token(
      new Date(Date.now() + DAY),
      ago(30 * DAY - MINUTE),
    );

    await untilIdle();

    expect(await exists(expired)).toBe(false);
    expect(await exists(revoked)).toBe(false);
    expect(await exists(inside)).toBe(true);
    expect(await exists(revokedInside)).toBe(true);
  });
});

describe('run values', () => {
  async function runWithValue(completedAt?: Date): Promise<string> {
    const runId = randomUUID();
    await admin.query(
      `insert into app.workflow_runs
        (id,workspace_id,workflow_id,workflow_version_id,trigger_type,status,
         started_at,completed_at,created_at,updated_at)
       values($1,$2,$3,$4,'manual',$5,$6,$7,$6,$6)`,
      [
        runId,
        workspaceId,
        randomUUID(),
        randomUUID(),
        completedAt === undefined ? 'running' : 'succeeded',
        completedAt ?? ago(400 * DAY),
        completedAt ?? null,
      ],
    );
    await admin.query(
      `insert into app.workflow_run_values(id,workspace_id,workflow_run_id,key,value)
       values($1,$2,$3,'key','{"kind":"inline","value":1}')`,
      [randomUUID(), workspaceId, runId],
    );
    return runId;
  }
  const values = async (runId: string) =>
    (
      await admin.query(
        'select 1 from app.workflow_run_values where workflow_run_id=$1',
        [runId],
      )
    ).rowCount;

  it('go a minute past 30 days, stay a minute inside, and stay on a live run', async () => {
    const past = await runWithValue(ago(30 * DAY + MINUTE));
    const inside = await runWithValue(ago(30 * DAY - MINUTE));
    const live = await runWithValue();

    await untilIdle();

    expect(await values(past)).toBe(0);
    expect(await values(inside)).toBe(1);
    expect(await values(live)).toBe(1);
  });
});

describe('variable sets', () => {
  // References, not age, own a set's lifetime.
  async function revisionExists(revision: number): Promise<boolean> {
    const result = await admin.query(
      `select 1 from app.workspace_variable_set_revisions
        where workspace_id=$1 and revision=$2`,
      [workspaceId, revision],
    );
    return result.rowCount === 1;
  }

  it('removes a set nothing names and keeps the current one and one a run used', async () => {
    await admin.query(
      `insert into app.workspace_variable_set_revisions(workspace_id,revision,values_json)
       select $1,n,'{}' from generate_series(1,3) n`,
      [workspaceId],
    );
    await admin.query(
      `insert into app.workspace_variables(workspace_id,revision) values($1,3)
       on conflict (workspace_id) do update set revision=excluded.revision`,
      [workspaceId],
    );
    await admin.query(
      `insert into app.workflow_runs
        (id,workspace_id,workflow_id,workflow_version_id,trigger_type,status,
         variable_set_revision,started_at,created_at,updated_at)
       values($1,$2,$3,$4,'manual','running',2,$5,$5,$5)`,
      [randomUUID(), workspaceId, randomUUID(), randomUUID(), new Date()],
    );

    await untilIdle();

    expect(await revisionExists(1)).toBe(false);
    expect(await revisionExists(2)).toBe(true);
    expect(await revisionExists(3)).toBe(true);
  });
});
