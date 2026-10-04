import { expect, it } from 'vitest';
import {
  configuredBranchOutputPorts,
  configuredParallelOutputPorts,
  inspectBranchSelection,
  inspectParallelDeclaration,
} from '../src/control-output-value.js';

it('derives condition and switch ports only from the existing pinned definitions', () => {
  expect(
    configuredBranchOutputPorts({
      definition: { key: 'core.condition', version: 1 },
    }),
  ).toEqual(['false', 'true']);
  const node = {
    definition: { key: 'core.switch', version: 1 },
    config: { cases: [{ id: 'case-02' }, { id: 'case-01' }] },
  };
  expect(configuredBranchOutputPorts(node)).toEqual([
    'case-02',
    'case-01',
    'default',
  ]);
  expect(
    configuredBranchOutputPorts({
      ...node,
      definition: { key: 'core.switch', version: 2 },
    }),
  ).toBeUndefined();
  expect(
    configuredBranchOutputPorts({
      ...node,
      config: { cases: [{ id: 'case-01' }, { id: 'case-01' }] },
    }),
  ).toBeUndefined();
  expect(
    configuredBranchOutputPorts({
      ...node,
      config: { cases: [{ id: 'case-17' }] },
    }),
  ).toBeUndefined();
});

it.each([1, 2, 3])(
  'keeps the existing parallel version %i ordered branch contract',
  (version) => {
    const node = {
      definition: { key: 'core.parallel', version },
      config: { branches: [{ id: 'branch-02' }, { id: 'branch-01' }] },
    };
    expect(configuredParallelOutputPorts(node)).toEqual([
      'branch-02',
      'branch-01',
    ]);
    expect(
      configuredParallelOutputPorts({
        ...node,
        config: { branches: [{ id: 'branch-01' }] },
      }),
    ).toBeUndefined();
    expect(
      configuredParallelOutputPorts({
        ...node,
        config: { branches: [{ id: 'branch-01' }, { id: 'branch-01' }] },
      }),
    ).toBeUndefined();
  },
);

it('accepts only the exact branch selection shape and a configured port', () => {
  expect(
    inspectBranchSelection({ selectedPort: 'true' }, ['false', 'true']),
  ).toBe('true');
  for (const value of [
    null,
    [],
    {},
    { selectedPort: 'other' },
    { selectedPort: 1 },
    { selectedPort: 'true', extra: true },
  ])
    expect(() => inspectBranchSelection(value, ['false', 'true'])).toThrow(
      TypeError,
    );
});

it('accepts only the exact ordered parallel declaration shape', () => {
  const ports = ['branch-02', 'branch-01'];
  expect(() => {
    inspectParallelDeclaration({ branchIds: ports }, ports);
  }).not.toThrow();
  for (const value of [
    null,
    [],
    {},
    { branchIds: ['branch-01', 'branch-02'] },
    { branchIds: ['branch-02'] },
    { branchIds: ports, extra: true },
  ])
    expect(() => {
      inspectParallelDeclaration(value, ports);
    }).toThrow(TypeError);
});

it('rejects output accessors without invoking them', () => {
  for (const [field, inspect] of [
    [
      'selectedPort',
      (value: unknown) => inspectBranchSelection(value, ['true']),
    ],
    [
      'branchIds',
      (value: unknown) => {
        inspectParallelDeclaration(value, ['branch-01', 'branch-02']);
      },
    ],
  ] as const) {
    let invoked = false;
    const value = Object.defineProperty({}, field, {
      enumerable: true,
      get() {
        invoked = true;
        return field === 'selectedPort' ? 'true' : ['branch-01', 'branch-02'];
      },
    });
    expect(() => {
      inspect(value);
    }).toThrow(TypeError);
    expect(invoked).toBe(false);
  }
});
