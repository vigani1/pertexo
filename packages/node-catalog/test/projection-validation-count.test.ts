import { describe, expect, it, vi } from 'vitest';
import type * as NodeSdkModule from '@pertexo/node-sdk';

const validationProbe = vi.hoisted(() => ({ calls: 0 }));

vi.mock('@pertexo/node-sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeSdkModule>();
  return {
    ...actual,
    parseRegistryRelease: (input: unknown) => {
      validationProbe.calls += 1;
      return actual.parseRegistryRelease(input);
    },
  };
});

import { platformBrowserNodeDefinitionCatalog } from '../src/index.js';

describe('browser catalog release validation ownership', () => {
  it('validates the whole serving release exactly once per projection', () => {
    const before = validationProbe.calls;

    const catalog = platformBrowserNodeDefinitionCatalog('validate_activation');

    expect(catalog.definitions.length).toBeGreaterThan(1);
    expect(validationProbe.calls - before).toBe(1);
  });
});
