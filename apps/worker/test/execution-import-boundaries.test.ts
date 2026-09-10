import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

describe('worker execution import boundaries', () => {
  it('keeps shared capability consumers independent of the production handler', async () => {
    const consumers = [
      'node-attempt-runtime.ts',
      'node-runtime-capabilities.ts',
      'preview-attempt-handler.ts',
      'provider-connection-runtime.ts',
    ];
    const sources = await Promise.all(
      consumers.map((file) =>
        readFile(path.resolve('src/execution', file), 'utf8'),
      ),
    );
    for (const source of sources)
      expect(source).not.toMatch(
        /import\s+type\s+\{[^}]*Capability[^}]*\}\s+from\s+'\.\/node-attempt-handler\.js'/su,
      );
  });
});
