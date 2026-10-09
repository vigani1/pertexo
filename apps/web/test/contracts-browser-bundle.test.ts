// @vitest-environment node

import { fileURLToPath } from 'node:url';
import { build } from 'vite';
import { describe, expect, it } from 'vitest';
import { browserContractConsumer } from './support/browser-contract-consumer';

describe('browser contract consumer bundle', () => {
  it('includes schema modules without client/OpenAPI projection code', async () => {
    expect(Object.keys(browserContractConsumer)).toEqual([
      'artifact',
      'connections',
      'failureNotifications',
      'nodeDefinitions',
      'nodeValidation',
      'problem',
      'schedules',
      'workspaces',
      'workflows',
      'workflowRun',
      'workflowPortable',
      'workflowPortablePreview',
      'parsePortableJson',
      'portableGraphDigest',
      'webhooks',
      'workspaceInbox',
    ]);
    const applicationDirectory = fileURLToPath(new URL('../', import.meta.url));
    const entry = fileURLToPath(
      new URL('./support/browser-contract-consumer.ts', import.meta.url),
    );
    const result = await build({
      configFile: false,
      root: applicationDirectory,
      logLevel: 'silent',
      build: {
        write: false,
        target: 'es2022',
        lib: { entry, formats: ['es'] },
      },
    });
    const outputs = Array.isArray(result) ? result : [result];
    const chunks = outputs.flatMap((output) => {
      if (!('output' in output)) throw new Error('Vite returned a watcher');
      return output.output.filter((item) => item.type === 'chunk');
    });
    const moduleIds = chunks.flatMap((chunk) => Object.keys(chunk.modules));
    const code = chunks.map((chunk) => chunk.code).join('\n');

    expect(
      moduleIds.some((id) => id.includes('/contracts/dist/schemas/')),
    ).toBe(true);
    expect(moduleIds.some((id) => id.endsWith('/errors/api-problem.js'))).toBe(
      true,
    );
    expect(
      moduleIds.some((id) => id.endsWith('/portability/contract.js')),
    ).toBe(true);
    expect(
      moduleIds.some((id) => id.includes('/contracts/dist/openapi/')),
    ).toBe(false);
    expect(
      moduleIds.some((id) => /\/node-catalog\/|\/workflow-engine\//u.test(id)),
    ).toBe(false);
    expect(moduleIds.some((id) => id.startsWith('node:'))).toBe(false);
    expect(code).not.toContain('Pertexo Catalog API');
    expect(code).not.toContain('openapi:');
  });
});
