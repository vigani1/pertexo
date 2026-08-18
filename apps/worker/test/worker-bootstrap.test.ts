import { describe, expect, it } from 'vitest';

import { createWorkerApplication } from '../src/app.js';

describe('worker application bootstrap', () => {
  it('creates a standalone context without an HTTP server', async () => {
    const app = await createWorkerApplication({
      nodeEnv: 'test',
      logLevel: 'debug',
    });

    try {
      expect('getHttpServer' in app).toBe(false);
    } finally {
      await app.close();
    }
  });
});
