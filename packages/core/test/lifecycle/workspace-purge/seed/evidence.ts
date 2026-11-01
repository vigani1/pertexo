import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';

import type { PurgeSeed } from '../base.js';

export async function seedPurgeEvidence(
  owner: Pool,
  ids: PurgeSeed,
): Promise<void> {
  const { workspaceId, userId, artifactId, workflowId } = ids;
  await owner.query(
    `insert into app.audit_events
          (id,workspace_id,actor_user_id,action,target_type,target_id,request_id,trace_id,metadata)
         values($1,$2,$3,'workspace.fixture','workspace',$3,'request-secret','trace-secret',$4)`,
    [randomUUID(), workspaceId, userId, { tenant: 'secret' }],
  );
  const usageId = randomUUID();
  await owner.query(
    `insert into app.usage_events
          (id,workspace_id,category,quantity,resource_type,resource_id,idempotency_key,metadata)
         values($1,$2,'preview.execution',1,'preview-run',$3,$4,$5)`,
    [
      usageId,
      workspaceId,
      randomUUID(),
      `usage-${usageId}`,
      { tenant: 'secret' },
    ],
  );
  const skipId = randomUUID();
  await owner.query(
    `insert into app.usage_events
          (id,workspace_id,category,quantity,resource_type,resource_id,idempotency_key,metadata)
         values($1::uuid,$2,'trigger.skipped',1,'workflow',$3,$1::text,
           '{"triggerType":"webhook","reason":"concurrency_limit"}')`,
    [skipId, workspaceId, workflowId],
  );
  const securityFactId = randomUUID();
  await owner.query(
    `insert into app.transport_security_audit_facts
          (id,workspace_id,fact_type,consumer_name,message_id)
         values($1,$2,'inbox_checksum_mismatch','worker.fixture',$3)`,
    [securityFactId, workspaceId, randomUUID()],
  );
  await owner.query(
    `insert into app.artifacts
          (id,workspace_id,purpose,storage_key,media_type,byte_length,sha256,expires_at)
         values($1::uuid,$2::uuid,'output','workspaces/'||$2::text||'/artifacts/'||$1::text,
          'application/json',2,$3,clock_timestamp()+interval '1 day')`,
    [artifactId, workspaceId, '9'.repeat(64)],
  );
}
