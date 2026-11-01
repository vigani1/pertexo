import { owner, workspaceId } from '../retention.support.js';

export async function readCapacity(): Promise<{
  chargedBytes: number;
  chargedCount: number;
}> {
  await owner.query('begin');
  try {
    await owner.query('set local role pertexo_owner');
    await owner.query("select set_config('app.workspace_id',$1,true)", [
      workspaceId,
    ]);
    const result = await owner.query<{
      charged_bytes: number | string;
      charged_count: number;
    }>(
      `select charged_bytes,charged_count
         from app.workspace_artifact_capacity where workspace_id=$1`,
      [workspaceId],
    );
    const row = result.rows[0];
    if (row === undefined) throw new Error('artifact capacity row missing');
    await owner.query('commit');
    return {
      chargedBytes: Number(row.charged_bytes),
      chargedCount: row.charged_count,
    };
  } catch (error: unknown) {
    await owner.query('rollback').catch(() => undefined);
    throw error;
  }
}

export async function withOwnerTransaction<T>(
  work: (client: typeof owner) => Promise<T>,
): Promise<T> {
  await owner.query('begin');
  try {
    await owner.query('set local role pertexo_owner');
    await owner.query("select set_config('app.workspace_id',$1,true)", [
      workspaceId,
    ]);
    const result = await work(owner);
    await owner.query('commit');
    return result;
  } catch (error: unknown) {
    await owner.query('rollback').catch(() => undefined);
    throw error;
  }
}

export async function insertExpiredPendingUserUpload(
  artifactId: string,
  digestCharacter: string,
): Promise<void> {
  await withOwnerTransaction(async (client) => {
    await client.query(
      `insert into app.artifacts
         (id,workspace_id,purpose,storage_key,media_type,byte_length,sha256,
          status,expires_at)
       values($1,$2,'user-upload',$3,'application/octet-stream',10,$4,
         'pending',clock_timestamp()-interval '1 hour')`,
      [
        artifactId,
        workspaceId,
        `workspaces/${workspaceId}/artifacts/${artifactId}`,
        digestCharacter.repeat(64),
      ],
    );
  });
}

export async function readArtifactRetentionState(artifactId: string): Promise<{
  status: string;
  retryScheduled: boolean;
}> {
  return withOwnerTransaction(async (client) => {
    const result = await client.query<{
      status: string;
      retry_scheduled: boolean | null;
    }>(
      `select status,retention_retry_at>clock_timestamp() as retry_scheduled
         from app.artifacts where workspace_id=$1 and id=$2`,
      [workspaceId, artifactId],
    );
    const row = result.rows[0];
    if (row === undefined) throw new Error('artifact retention state missing');
    return {
      status: row.status,
      retryScheduled: row.retry_scheduled === true,
    };
  });
}

export async function setArtifactRetryAt(
  artifactId: string,
  value: 'past' | 'null',
): Promise<void> {
  await withOwnerTransaction(async (client) => {
    await client.query(
      value === 'past'
        ? `update app.artifacts
             set retention_retry_at=clock_timestamp()-interval '1 second'
           where workspace_id=$1 and id=$2`
        : `update app.artifacts
             set retention_retry_at=null
           where workspace_id=$1 and id=$2`,
      [workspaceId, artifactId],
    );
  });
}

export type ArtifactStoreInput = Readonly<{
  artifactId: string;
  signal?: AbortSignal;
  workspaceId: string;
}>;

export async function beforeEachFixture1() {
  await withOwnerTransaction(async (client) => {
    await client.query(
      `update app.workflow_runs
         set input_ref=null,input_ref_expires_at=null,output_ref=null
       where workspace_id=$1`,
      [workspaceId],
    );
    await client.query('delete from app.artifact_links where workspace_id=$1', [
      workspaceId,
    ]);
    await client.query('alter table app.artifacts disable trigger user');
    await client.query('delete from app.artifacts where workspace_id=$1', [
      workspaceId,
    ]);
    await client.query('alter table app.artifacts enable trigger user');
    await client.query(
      `update app.workspace_artifact_capacity
         set charged_bytes=0,charged_count=0,updated_at=clock_timestamp()
       where workspace_id=$1`,
      [workspaceId],
    );
  });
}
