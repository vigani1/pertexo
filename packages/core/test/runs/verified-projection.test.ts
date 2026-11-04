import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { CORE_NODE_CATALOG } from '@pertexo/nodes-core';
import {
  buildWorkflowExecutable,
  composeExecutableCatalog,
} from '@pertexo/workflow-engine';
import { verifyPersistedWorkflowProjection } from '../../src/runs/queries/execution/verify-projection.js';
import { isStoredDataError } from '../../src/shared/stored-values.js';

const catalog = composeExecutableCatalog(CORE_NODE_CATALOG);
function projection() {
  const compiled = buildWorkflowExecutable({
    catalog,
    graph: {
      nodes: [
        {
          id: 'start',
          definition: { key: 'core.manual', version: 1 },
          position: { x: 0, y: 0 },
          configVersion: 1,
          config: {},
          inputMappings: {},
          connectionRefs: {},
        },
      ],
      edges: [],
      settings: {},
    },
  });
  return {
    id: randomUUID(),
    workspaceId: randomUUID(),
    workflowId: randomUUID(),
    versionNumber: 1,
    executableJson: compiled.envelope,
    checksum: compiled.checksum,
  };
}
const wireCopy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

describe('verified immutable execution projections', () => {
  it('reuses the same verified immutable result across fresh database JSON reads', () => {
    const stored = projection();
    const first = verifyPersistedWorkflowProjection(wireCopy(stored), {
      catalog,
    });
    const next = verifyPersistedWorkflowProjection(wireCopy(stored), {
      catalog: wireCopy(catalog),
    });
    expect(next).toBe(first);
    expect(next.checksum).toBe(stored.checksum);
    expect(Object.isFrozen(next.envelope.graph.nodes)).toBe(true);
  });

  it('refuses changed content or checksum without poisoning a previously verified version', () => {
    const stored = projection();
    const verified = verifyPersistedWorkflowProjection(stored, { catalog });
    const changed = wireCopy(stored);
    const envelope = changed.executableJson as unknown as {
      graph: { nodes: { id: string }[] };
    };
    const firstNode = envelope.graph.nodes[0];
    if (firstNode === undefined) throw new Error('Missing fixture node');
    firstNode.id = 'changed';
    const nonJson = wireCopy(stored);
    Object.assign(nonJson.executableJson, { hidden: undefined });
    for (const damaged of [
      changed,
      nonJson,
      { ...stored, checksum: '0'.repeat(64) },
    ]) {
      let failure: unknown;
      try {
        verifyPersistedWorkflowProjection(damaged, { catalog });
      } catch (error: unknown) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(Error);
      expect(isStoredDataError(failure)).toBe(true);
    }
    expect(
      verifyPersistedWorkflowProjection(wireCopy(stored), { catalog }),
    ).toBe(verified);
  });

  it('checks current catalog compatibility, including mutations of the same catalog object', () => {
    const stored = projection();
    const served = wireCopy(catalog);
    const verified = verifyPersistedWorkflowProjection(stored, {
      catalog: served,
    });
    const incompatible = { ...served, definitions: [] };
    expect(() =>
      verifyPersistedWorkflowProjection(stored, { catalog: incompatible }),
    ).toThrow();
    Object.assign(served, incompatible);
    expect(() =>
      verifyPersistedWorkflowProjection(stored, { catalog: served }),
    ).toThrow();
    expect(verifyPersistedWorkflowProjection(stored, { catalog })).toBe(
      verified,
    );
  });

  it('bounds retained results and verifies a version again after eviction', () => {
    const oldest = projection();
    const first = verifyPersistedWorkflowProjection(oldest, { catalog });
    for (let index = 0; index < 64; index++)
      verifyPersistedWorkflowProjection(
        { ...oldest, id: randomUUID() },
        { catalog },
      );
    const revisited = verifyPersistedWorkflowProjection(wireCopy(oldest), {
      catalog,
    });
    expect(revisited).toEqual(first);
    expect(revisited).not.toBe(first);
    expect(
      verifyPersistedWorkflowProjection(wireCopy(oldest), { catalog }),
    ).toBe(revisited);
  });
});
