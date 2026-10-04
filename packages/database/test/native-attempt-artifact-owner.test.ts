import { describe, expect, it } from 'vitest';
import {
  reserveNativeAttemptArtifact,
  inspectNativeAttemptArtifact,
} from '../src/execution/artifacts/native-attempt-artifact-owner.js';
import { NativeArtifactPreparationUnavailableError } from '../src/execution/artifacts/native-attempt-artifact-contract.js';
import {
  fixture,
  owner,
  metadata,
} from './support/native-artifact-owner.fixture.js';

describe('native attempt artifact owner (external pg, not SQL authority qualification)', () => {
  it('creates pending metadata and candidate on one current-proven client before committing', async () => {
    const f = fixture('fresh');
    const reserved = await reserveNativeAttemptArtifact(f.pool, f.request);
    expect(reserved).toMatchObject({
      ...metadata,
      artifactId: reserved.artifactId,
    });
    const names = f.client.statements.map(({ text }) => text);
    const proof = names.findIndex((text) =>
      text.includes('prepare_native_attempt_artifact_candidate'),
    );
    const artifact = names.findIndex((text) =>
      text.startsWith('insert into "app"."artifacts"'),
    );
    const candidate = names.findIndex((text) =>
      text.includes('register_native_attempt_artifact_candidate'),
    );
    expect(proof).toBeLessThan(artifact);
    expect(artifact).toBeLessThan(candidate);
    expect(candidate).toBeLessThan(names.indexOf('commit'));
    expect(names.filter((text) => text === 'begin')).toHaveLength(1);
    expect(
      names.some(
        (text) => text.includes('provenance') || text.includes('association'),
      ),
    ).toBe(false);
    expect(f.client.releases).toHaveLength(1);
  });
  it.each(['reuse', 'available'] as const)(
    'reuses %s metadata without inserting or charging again',
    async (mode) => {
      const f = fixture(mode);
      await expect(
        reserveNativeAttemptArtifact(f.pool, f.request),
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
    'rejects %s before artifact creation',
    async (mode) => {
      const f = fixture(mode);
      const operation = reserveNativeAttemptArtifact(f.pool, f.request);
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
      expect(f.client.releases).toHaveLength(1);
    },
  );
  it('rolls pending artifact creation back when candidate registration fails', async () => {
    const f = fixture('registration_denied');
    await expect(
      reserveNativeAttemptArtifact(f.pool, f.request),
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
  it('reproves the exact reservation then delegates existing finalization, without another insert', async () => {
    const f = fixture('reuse');
    await inspectNativeAttemptArtifact(
      f.pool,
      { owner, reserved: metadata, signal: f.signal },
      true,
    );
    const names = f.client.statements.map(({ text }) => text);
    expect(
      names.findIndex((text) => text.includes('prepare_native')),
    ).toBeLessThan(names.findIndex((text) => text.includes('for update')));
    expect(
      names.some((text) => text.startsWith('update "app"."artifacts"')),
    ).toBe(true);
    expect(names.some((text) => text.startsWith('insert'))).toBe(false);
  });
  it('does not extend or rewrite an already available artifact', async () => {
    const f = fixture('available');
    await inspectNativeAttemptArtifact(
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
  it('rolls back expired finalization through the existing lifecycle owner', async () => {
    const f = fixture('expired');
    await expect(
      inspectNativeAttemptArtifact(
        f.pool,
        { owner, reserved: metadata, signal: f.signal },
        true,
      ),
    ).rejects.toThrow('Pending artifact has expired');
    expect(
      f.client.statements.some(
        ({ text }) => text === 'commit' || text.startsWith('update'),
      ),
    ).toBe(false);
  });
});
