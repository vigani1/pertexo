import { describe, expect, it } from 'vitest';
import {
  reserveNativeResultArtifact,
  inspectNativeResultArtifact,
} from '../src/execution/artifacts/native-result-artifact-owner.js';
import { NativeArtifactPreparationUnavailableError } from '../src/execution/artifacts/native-attempt-artifact-contract.js';
import {
  fixture,
  owner as attemptOwner,
  metadata,
} from './support/native-artifact-owner.fixture.js';

const owner = {
  kind: 'run_result' as const,
  workspaceId: attemptOwner.lease.workspaceId,
  runId: attemptOwner.lease.runId,
  workflowVersionId: attemptOwner.lease.workflowVersionId,
  delivery: attemptOwner.lease.delivery,
  expectedRevision: 4,
  resultRevision: 5,
  resultIdentity: 'c'.repeat(64),
};
const sqlOwner = {
  workspaceId: owner.workspaceId,
  runId: owner.runId,
  workflowVersionId: owner.workflowVersionId,
  expectedRevision: owner.expectedRevision,
  delivery: owner.delivery,
};

describe('native result artifact lifecycle (external pg, not SQL qualification)', () => {
  it('reserves through the current pre/post identity and existing quota owner, registering on the same transaction', async () => {
    const f = fixture('fresh');
    const reserved = await reserveNativeResultArtifact(f.pool, {
      ...f.request,
      owner,
    });
    const prepare = f.client.statements.find(({ text }) =>
      text.includes('prepare_native_result_artifact_candidate'),
    );
    const register = f.client.statements.find(({ text }) =>
      text.includes('register_native_result_artifact_candidate'),
    );
    expect(prepare?.values).toEqual([
      JSON.stringify(sqlOwner),
      5,
      owner.resultIdentity,
      metadata.sha256,
      metadata.byteLength,
      metadata.mediaType,
      null,
    ]);
    expect(register?.values).toEqual([
      JSON.stringify(sqlOwner),
      5,
      owner.resultIdentity,
      expect.any(String),
      reserved.artifactId,
      metadata.sha256,
      metadata.byteLength,
      metadata.mediaType,
    ]);
    const sql = f.client.statements.map(({ text }) => text);
    expect(
      sql.findIndex((text) => text.includes('prepare_native_result')),
    ).toBeLessThan(
      sql.findIndex((text) => text.startsWith('insert into "app"."artifacts"')),
    );
    expect(
      sql.findIndex((text) => text.includes('register_native_result')),
    ).toBeLessThan(sql.indexOf('commit'));
    expect(sql.filter((text) => text === 'begin')).toHaveLength(1);
    expect(
      sql.some(
        (text) => text.includes('provenance') || text.includes('association'),
      ),
    ).toBe(false);
    expect(f.client.releases).toHaveLength(1);
  });

  it.each(['reuse', 'available'] as const)(
    'reuses %s exact candidates without another insert or charge',
    async (mode) => {
      const f = fixture(mode);
      await expect(
        reserveNativeResultArtifact(f.pool, { ...f.request, owner }),
      ).resolves.toEqual({ ...metadata, available: mode === 'available' });
      expect(
        f.client.statements.some(
          ({ text }) =>
            text.startsWith('insert') || text.includes('register_native'),
        ),
      ).toBe(false);
    },
  );

  it.each(['denied', 'unavailable', 'substituted', 'abort'] as const)(
    'rejects %s before pending-artifact creation',
    async (mode) => {
      const f = fixture(mode);
      const operation = reserveNativeResultArtifact(f.pool, {
        ...f.request,
        owner,
      });
      if (mode === 'unavailable')
        await expect(operation).rejects.toBeInstanceOf(
          NativeArtifactPreparationUnavailableError,
        );
      else await expect(operation).rejects.toBeInstanceOf(Error);
      expect(
        f.client.statements.some(
          ({ text }) => text.startsWith('insert') || text === 'commit',
        ),
      ).toBe(false);
    },
  );

  it('rolls back the pending artifact when protected candidate registration denies it', async () => {
    const f = fixture('registration_denied');
    await expect(
      reserveNativeResultArtifact(f.pool, { ...f.request, owner }),
    ).rejects.toThrow('registration denied');
    expect(
      f.client.statements.some(({ text }) =>
        text.startsWith('insert into "app"."artifacts"'),
      ),
    ).toBe(true);
    expect(f.client.statements.some(({ text }) => text === 'rollback')).toBe(
      true,
    );
    expect(f.client.statements.some(({ text }) => text === 'commit')).toBe(
      false,
    );
  });

  it('reproves the same result candidate before existing finalization without recharging', async () => {
    const f = fixture('reuse');
    await inspectNativeResultArtifact(
      f.pool,
      { owner, reserved: metadata, signal: f.signal },
      true,
    );
    const prepare = f.client.statements.find(({ text }) =>
      text.includes('prepare_native_result'),
    );
    expect(prepare?.values.at(-1)).toBe(metadata.artifactId);
    expect(
      f.client.statements.some(({ text }) =>
        text.startsWith('update "app"."artifacts"'),
      ),
    ).toBe(true);
    expect(
      f.client.statements.some(({ text }) => text.startsWith('insert')),
    ).toBe(false);
  });

  it('does not rewrite an already available result artifact', async () => {
    const f = fixture('available');
    await inspectNativeResultArtifact(
      f.pool,
      { owner, reserved: metadata, signal: f.signal },
      true,
    );
    expect(
      f.client.statements.some(
        ({ text }) => text.startsWith('update') || text.startsWith('insert'),
      ),
    ).toBe(false);
  });

  it.each([{ resultRevision: 6 }, { resultIdentity: 'invalid' }])(
    'rejects invalid producer metadata %j before checkout',
    async (changed) => {
      const f = fixture('reuse');
      await expect(
        reserveNativeResultArtifact(f.pool, {
          ...f.request,
          owner: { ...owner, ...changed },
        }),
      ).rejects.toBeInstanceOf(Error);
      expect(f.client.statements).toHaveLength(0);
    },
  );
});
