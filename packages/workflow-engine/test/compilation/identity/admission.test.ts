import { describe, expect, it } from 'vitest';

import {
  buildWorkflowExecutable,
  composeExecutableCatalog,
  computeWorkflowExecutableChecksum,
  parseWorkflowExecutable,
  verifyWorkflowExecutable,
} from '../../../src/index.js';
import { nodeCatalog, graph } from '../../support/executable-workflow.js';
describe('workflow executable identity', () => {
  it('pins side-effect class into behavior identity and rejects a mutated pin', () => {
    const safeCatalog = composeExecutableCatalog(nodeCatalog());
    const idempotentCatalog = composeExecutableCatalog(
      nodeCatalog({ setRetryClass: 'idempotent-with-key' }),
    );
    const safe = buildWorkflowExecutable({
      graph: graph(),
      catalog: safeCatalog,
    });
    const idempotent = buildWorkflowExecutable({
      graph: graph(),
      catalog: idempotentCatalog,
    });
    expect(
      idempotent.envelope.graph.nodes.find(({ id }) => id === 'set')
        ?.sideEffectClass,
    ).toBe('idempotent_with_key');
    expect(idempotent.checksum).not.toBe(safe.checksum);

    const mutated = structuredClone(safe.envelope);
    const set = mutated.graph.nodes.find(({ id }) => id === 'set');
    if (set === undefined) throw new Error('fixture set node missing');
    Object.assign(set, { sideEffectClass: 'unsafe' });
    expect(computeWorkflowExecutableChecksum(mutated)).not.toBe(safe.checksum);
    expect(() =>
      parseWorkflowExecutable({
        envelope: mutated,
        catalog: safeCatalog,
      }),
    ).toThrow(expect.objectContaining({ code: 'executable_invalid' }));

    for (const invalidClass of ['idempotent-with-key', 'unknown']) {
      const wrong = structuredClone(safe.envelope);
      const wrongSet = wrong.graph.nodes.find(({ id }) => id === 'set');
      if (wrongSet === undefined) throw new Error('fixture set node missing');
      Object.assign(wrongSet, { sideEffectClass: invalidClass });
      expect(() =>
        parseWorkflowExecutable({
          envelope: wrong,
          catalog: safeCatalog,
        }),
      ).toThrow(expect.objectContaining({ code: 'executable_invalid' }));
    }

    const missing = structuredClone(safe.envelope);
    const missingSet = missing.graph.nodes.find(({ id }) => id === 'set');
    if (missingSet === undefined) throw new Error('fixture set node missing');
    Reflect.deleteProperty(missingSet, 'sideEffectClass');
    expect(() =>
      parseWorkflowExecutable({
        envelope: missing,
        catalog: safeCatalog,
      }),
    ).toThrow(expect.objectContaining({ code: 'executable_invalid' }));

    const driftedCurrent = composeExecutableCatalog(
      nodeCatalog({ setRetryClass: 'idempotent-with-key' }),
    );
    expect(() =>
      parseWorkflowExecutable({
        envelope: safe.envelope,
        catalog: driftedCurrent,
      }),
    ).toThrow(expect.objectContaining({ code: 'executable_invalid' }));
  });
  it('maps all manifest retry classes once into pinned ADR 007 vocabulary', () => {
    const catalog = composeExecutableCatalog(
      nodeCatalog({
        manualRetryClass: 'unsafe',
        setRetryClass: 'idempotent-with-key',
      }),
    );
    expect(
      buildWorkflowExecutable({
        graph: graph(),
        catalog,
      }).envelope.graph.nodes.map(({ sideEffectClass }) => sideEffectClass),
    ).toEqual(['unsafe', 'idempotent_with_key', 'safe']);
  });
  it('fails closed for mutated pins, checksum and malformed envelopes', () => {
    const catalog = composeExecutableCatalog(nodeCatalog());
    const compiled = buildWorkflowExecutable({ graph: graph(), catalog });
    const mutated = structuredClone(compiled.envelope);
    const set = mutated.graph.nodes.find(({ id }) => id === 'set');
    if (set === undefined) throw new Error('fixture set node missing');
    Object.assign(set.executor, { version: 2 });
    expect(() =>
      parseWorkflowExecutable({
        envelope: mutated,
        catalog,
      }),
    ).toThrow(expect.objectContaining({ code: 'executable_invalid' }));
    expect(() =>
      verifyWorkflowExecutable({
        envelope: compiled.envelope,
        checksum: compiled.checksum.replace(/.$/u, '0'),
        catalog,
      }),
    ).toThrow(expect.objectContaining({ code: 'executable_invalid' }));
    expect(() =>
      parseWorkflowExecutable({
        envelope: { ...compiled.envelope, unknown: true },
        catalog,
      }),
    ).toThrow(expect.objectContaining({ code: 'executable_invalid' }));
    expect(() =>
      parseWorkflowExecutable({
        envelope: {},
        catalog,
      }),
    ).toThrow(expect.objectContaining({ code: 'executable_invalid' }));
  });
  it('preserves escaped, control, and Unicode JSON while normalizing negative zero', () => {
    const catalog = composeExecutableCatalog(nodeCatalog());
    const source = structuredClone(graph());
    const set = source.nodes.find(({ id }) => id === 'set');
    if (set === undefined) throw new Error('fixture set node missing');
    Object.assign(set.inputMappings, {
      literal: {
        kind: 'literal',
        value: {
          escaped: 'line\n"quoted"\\slash',
          control: '\u0001',
          euro: '€',
          loneHighSurrogate: '\ud800',
          loneLowSurrogate: '\udc00',
          unicode: 'Živjo 🙂',
          negativeZero: -0,
        },
      },
    });

    const compiled = buildWorkflowExecutable({ graph: source, catalog });
    const parsed = parseWorkflowExecutable({
      envelope: compiled.envelope,
      catalog: catalog,
    });
    const parsedSet = parsed.graph.nodes.find(({ id }) => id === 'set');
    const literal = parsedSet?.inputMappings.literal;
    expect(literal).toMatchObject({
      kind: 'literal',
      value: {
        escaped: 'line\n"quoted"\\slash',
        control: '\u0001',
        euro: '€',
        loneHighSurrogate: '\ud800',
        loneLowSurrogate: '\udc00',
        unicode: 'Živjo 🙂',
        negativeZero: 0,
      },
    });
    if (literal?.kind !== 'literal' || typeof literal.value !== 'object')
      throw new Error('fixture literal mapping missing');
    expect(
      Object.is((literal.value as { negativeZero: number }).negativeZero, -0),
    ).toBe(false);
  });
});
