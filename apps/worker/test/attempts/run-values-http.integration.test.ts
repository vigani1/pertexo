import { it, expect, vi } from 'vitest';
import { z } from 'zod';
import type { RunValuesStore } from '@pertexo/core/runs';
import { createRunValuesRuntime } from '../../src/attempts/execution/run-values.js';
import {
  controlledActionUrl,
  createEditorControlledHttpTarget,
} from '../support/editor-browser/controlled-http.js';
it('keeps known connection credentials echoed by a real HTTP service out of saved business values', async () => {
  const credential = 'Bearer known-connection-secret';
  const target = createEditorControlledHttpTarget(credential);
  const save = vi
    .fn<RunValuesStore['save']>()
    .mockImplementation(({ values }) => Promise.resolve(values));
  try {
    await target.start();
    const response = await target.httpClient.execute({
      url: controlledActionUrl,
      method: 'POST',
      headers: {
        authorization: credential,
        'content-type': 'application/json',
      },
      body: Buffer.from(
        JSON.stringify({ orderId: 'A-1042', tracking: credential }),
      ),
      sensitiveValues: [credential],
      maxRedirects: 0,
      maxResponseBytes: 4096,
      timeoutMillis: 5000,
      beforeDispatch: () => Promise.resolve(),
    });
    const parsed = z
      .object({ body: z.record(z.string(), z.string()) })
      .parse(JSON.parse(Buffer.from(response.body).toString('utf8')));
    const context = {
      workspaceId: 'workspace',
      runId: 'run',
      nodeRunId: 'node',
      attemptId: 'attempt',
      attemptNumber: 1,
      workerId: 'worker',
      fenceToken: 1,
      nodeId: 'save',
      invocationKey: 'save',
    };
    const values = await createRunValuesRuntime(
      { save },
      context,
      () => undefined,
    ).save({ values: parsed.body, signal: new AbortController().signal });
    expect(values.orderId).toBe('A-1042');
    expect(values.tracking).toContain('[Redacted]');
    expect(JSON.stringify(save.mock.calls)).not.toContain(
      'known-connection-secret',
    );
    expect(target.observe().effects).toBe(1);
  } finally {
    await target.close();
  }
});
