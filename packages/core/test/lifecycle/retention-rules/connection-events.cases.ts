import { expect, it } from 'vitest';
import { randomUUID, retention, userId } from '../retention.support.js';
import { admin, daysAgo, enforceUntilIdle } from './fixture.js';

export function registerConnectionEvents(): void {
  it('retains connection events according to each workspace audit setting', async () => {
    const workspaceId = randomUUID();
    const otherWorkspace = randomUUID();
    for (const [ws, days] of [
      [workspaceId, 30],
      [otherWorkspace, 365],
    ] as const)
      await admin.query(
        "insert into app.workspaces(id,name,slug,created_by,audit_retention_days) values($1,'Retention',$2,$3,$4)",
        [ws, `retention-${ws}`, userId, days],
      );
    const ids = Array.from({ length: 4 }, () => randomUUID());
    for (const [index, ws] of [workspaceId, otherWorkspace].entries()) {
      const connection = randomUUID();
      const secret = randomUUID();
      await admin.query(
        `with inserted_connection as (insert into app.connections(id,workspace_id,provider_key,name,auth_type,status,current_secret_version_id,created_by)
         values($1,$2,'email','Retention','resend_api_key','active',$3,$4) returning id)
         insert into app.connection_secret_versions(id,workspace_id,connection_id,kms_key_reference,encrypted_data_key,ciphertext,nonce,auth_tag,created_by)
         select $3,$2,id,'kms','key','cipher','AAAAAAAAAAAAAAAA','AAAAAAAAAAAAAAAAAAAAAA',$4 from inserted_connection`,
        [connection, ws, secret, userId],
      );
      for (const [id, age] of index === 0
        ? [
            [ids[0], 40],
            [ids[1], 29],
            [ids[2], 10],
          ]
        : [[ids[3], 40]]) {
        await admin.query(
          "insert into app.connection_events(id,workspace_id,connection_id,event_type,actor_kind,actor_id,created_at) values($1,$2,$3,'connection.created','system','retention-test',$4)",
          [id, ws, connection, daysAgo(Number(age))],
        );
      }
    }
    const result = await retention.enforce();
    expect(result.removed.connection_events).toBe(1);
    await enforceUntilIdle();
    const rows = await admin.query<{ id: string }>(
      'select id from app.connection_events where id=any($1::uuid[])',
      [ids],
    );
    expect(rows.rows.map((row) => row.id).sort()).toEqual(ids.slice(1).sort());
  });
}
