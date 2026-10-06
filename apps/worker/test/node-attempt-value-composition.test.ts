import { describe, expect, it, vi } from 'vitest';
import type {
  NativeNodeAttemptValueSource,
  NodeAttemptRunStore,
} from '@pertexo/database/execution';
import { createNodeAttemptValueComposition } from '../src/execution/node-attempt-value-composition.js';
import { lease } from './support/node-attempt-handler.fixture.js';

const current = lease();
const snapshot = {
  reference: {
    schemaVersion: 1 as const,
    kind: 'inline' as const,
    value: null,
  },
  serializedValue: 'null',
  byteLength: 4,
  sha256: '74234e98afe7498fb5daf1f36ac2d78acc339464f950703b8c019892f982b90b',
};
const source: NativeNodeAttemptValueSource = {
  slot: 'run_input',
  source: {
    kind: 'run_input',
    provenanceId: '99999999-9999-4999-8999-999999999999',
    workspaceId: current.workspaceId,
    runId: current.runId,
    workflowVersionId: current.workflowVersionId,
  },
  snapshot,
};
const owner = { kind: 'attempt' as const, lease: current };
const signal = () => new AbortController().signal;

describe('minimum attempt value production composition (external persistence ports)', () => {
  it('reauthorizes native input using the real attempt lease and shared source codec', async () => {
    const read = vi.fn<
      NonNullable<NodeAttemptRunStore['readNativeValueSource']>
    >(() => Promise.resolve(source));
    const values = createNodeAttemptValueComposition({
      readNativeValueSource: read,
    });
    const active = signal();
    await expect(
      values.nativeInputValues.hydrateSource({ owner, source, signal: active }),
    ).resolves.toBeNull();
    expect(read).toHaveBeenCalledExactlyOnceWith({
      lease: current,
      source,
      signal: active,
    });
  });
  it('prepares Call inline bytes with the existing codec and separately rereads accepted recovery', async () => {
    const read = vi.fn<
      NonNullable<NodeAttemptRunStore['readCallDeclarationInput']>
    >(() => Promise.resolve(snapshot));
    const values = createNodeAttemptValueComposition({
      readCallDeclarationInput: read,
    });
    await expect(
      values.callDeclarationValues.prepare({
        owner: { ...owner, slot: 'call_input' },
        value: null,
        signal: signal(),
      }),
    ).resolves.toMatchObject({
      reference: snapshot.reference,
      sha256: snapshot.sha256,
      byteLength: 4,
    });
    expect(read).not.toHaveBeenCalled();
    const active = signal();
    await expect(
      values.callDeclarationValues.hydrate({
        owner,
        reference: snapshot.reference,
        signal: active,
      }),
    ).resolves.toBeNull();
    expect(read).toHaveBeenCalledExactlyOnceWith({
      lease: current,
      signal: active,
    });
  });
  it('rejects accepted Call recovery disagreement without preparing or accepting a replacement', async () => {
    const values = createNodeAttemptValueComposition({
      readCallDeclarationInput: () => Promise.resolve(snapshot),
    });
    await expect(
      values.callDeclarationValues.hydrate({
        owner,
        reference: { schemaVersion: 1, kind: 'inline', value: 0 },
        signal: signal(),
      }),
    ).rejects.toThrow('independently accepted reference differs');
  });
  it('keeps artifact preparation unavailable without fabricating a reservation or object writer', async () => {
    const values = createNodeAttemptValueComposition({});
    await expect(
      values.callDeclarationValues.prepare({
        owner: { ...owner, slot: 'call_input' },
        value: 'x'.repeat(270_000),
        signal: signal(),
      }),
    ).rejects.toThrow('artifact production is not implemented');
  });
  it('refuses producer-slot confusion and missing consumer owners', async () => {
    const values = createNodeAttemptValueComposition({});
    expect(() =>
      values.callDeclarationValues.prepare({
        owner: { ...owner, slot: 'physical_output' },
        value: null,
        signal: signal(),
      }),
    ).toThrow('producer scope differs');
    await expect(
      values.nativeInputValues.hydrateSource({
        owner,
        source,
        signal: signal(),
      }),
    ).rejects.toThrow('source owner is unavailable');
  });
  it('does not reread accepted Call input after abort', async () => {
    const read =
      vi.fn<NonNullable<NodeAttemptRunStore['readCallDeclarationInput']>>();
    const values = createNodeAttemptValueComposition({
      readCallDeclarationInput: read,
    });
    const controller = new AbortController();
    controller.abort();
    await expect(
      values.callDeclarationValues.hydrate({
        owner,
        reference: snapshot.reference,
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(read).not.toHaveBeenCalled();
  });
});
