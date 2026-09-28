import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  platformBrowserNodeDefinitionCatalog,
  platformServingRegistryRelease,
} from '@pertexo/node-catalog';
import {
  composeExecutableCompatibilityRelease,
  describeExecutableCompatibilityRelease,
} from '@pertexo/workflow-engine';
import {
  verifiedScheduleAcceptanceInstant,
  verifyScheduleReleasePairs,
} from './editor-schedule-evidence.js';

describe('schedule catalog and executable release evidence', () => {
  const catalog = platformBrowserNodeDefinitionCatalog(
    'schedule_activation',
  ).release;
  const { epoch, fingerprint } = describeExecutableCompatibilityRelease(
    composeExecutableCompatibilityRelease(
      platformServingRegistryRelease('schedule_activation'),
    ),
  );
  const executable = { epoch, fingerprint };
  const { epoch: coreEpoch, fingerprint: coreFingerprint } =
    describeExecutableCompatibilityRelease(
      composeExecutableCompatibilityRelease(
        platformServingRegistryRelease('core'),
      ),
    );

  it('verifies distinct real projections from the same cohort and epoch', () => {
    expect(catalog.epoch).toBe(executable.epoch);
    expect(catalog.fingerprint).not.toBe(executable.fingerprint);
    expect(() => {
      verifyScheduleReleasePairs(catalog, executable);
    }).not.toThrow();
  });

  it.each([
    ['swapped projections', executable, catalog],
    ['executable fingerprint presented as catalog', executable, executable],
    ['catalog fingerprint presented as executable', catalog, catalog],
    [
      'wrong catalog epoch',
      { ...catalog, epoch: catalog.epoch + 1 },
      executable,
    ],
    ['wrong executable epoch', catalog, { ...executable, epoch: epoch + 1 }],
    [
      'wrong catalog fingerprint at the same epoch',
      { ...catalog, fingerprint: `node-compat:v1:sha256:${'0'.repeat(64)}` },
      executable,
    ],
    [
      'wrong executable fingerprint at the same epoch',
      catalog,
      { ...executable, fingerprint: `node-compat:v1:sha256:${'0'.repeat(64)}` },
    ],
    [
      'another catalog cohort',
      platformBrowserNodeDefinitionCatalog('core').release,
      executable,
    ],
    [
      'another executable cohort',
      catalog,
      { epoch: coreEpoch, fingerprint: coreFingerprint },
    ],
  ])('rejects %s', (_name, catalogInput, executableInput) => {
    expect(() => {
      verifyScheduleReleasePairs(catalogInput, executableInput);
    }).toThrow();
  });
});

describe('schedule history precision and original acceptance identity', () => {
  it.each(['000', '148'])(
    'accepts only zero extension of .%s and retains original receipt bytes',
    (fraction) => {
      const original = `2026-09-28T11:06:34.${fraction}Z`;
      const history = `2026-09-28T11:06:34.${fraction}000Z`;
      const verified = verifiedScheduleAcceptanceInstant(original, history);
      expect(verified).toBe(original);
      const hash = (instant: string) =>
        createHash('sha256').update(`trigger:${instant}`).digest('hex');
      expect(hash(verified)).toBe(hash(original));
      expect(hash(verified)).not.toBe(hash(history));
    },
  );
  it.each([
    '2026-09-28T11:06:34.148001Z',
    '2026-09-28T11:06:34.147999Z',
    '2026-09-28T11:06:33.148000Z',
    '2026-09-28T11:06:35.148000Z',
    '2026-09-28T11:06:34.148Z',
    '2026-09-28T11:06:34.1480000Z',
    'not-an-instant',
  ])(
    'rejects a different instant or malformed history precision: %s',
    (history) => {
      expect(() =>
        verifiedScheduleAcceptanceInstant('2026-09-28T11:06:34.148Z', history),
      ).toThrow();
    },
  );
  it.each([
    '2026-09-28T11:06:34.148000Z',
    '2026-09-28T11:06:34Z',
    'not-an-instant',
  ])('rejects altered scanner-format identity: %s', (original) => {
    expect(() =>
      verifiedScheduleAcceptanceInstant(
        original,
        '2026-09-28T11:06:34.148000Z',
      ),
    ).toThrow();
  });
});
