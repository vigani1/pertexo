import { describe, expect, it } from 'vitest';

import { advanceWorkflow } from '../../src/index.js';

import {
  version,
  at,
  id,
  key,
  fixture,
} from '../support/failure-routing/runtime.js';

describe('handler input evidence', () => {
  it('rejects a forged selected sink when advancing a restored checkpoint', async () => {
    const f = fixture();
    await f.step();
    await f.success('manual');
    await f.fail();
    const cp = f.checkpoint();
    const corrupted = {
      ...cp,
      invocations: cp.invocations.map((n) =>
        n.nodeId === 'set'
          ? {
              ...n,
              failureHandling: {
                disposition: 'pending',
                sinkInvocationKey: key('terminate'),
              },
            }
          : n,
      ),
    };
    await expect(
      advanceWorkflow({
        runId: id,
        executable: f.executable,
        workflowVersionId: version,
        checkpoint: corrupted,
        occurredAt: at,
        maximumAdmissions: 5,
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ code: 'workflow_identity_invalid' });
  });
});
it('refuses a successful sink paired with a skipped selected handler entry', async () => {
  const f = fixture();
  await f.step();
  await f.success('manual');
  await f.fail();
  const checkpoint = f.checkpoint();
  const corrupted = {
    ...checkpoint,
    invocations: [
      ...checkpoint.invocations.map((invocation) =>
        invocation.nodeId === 'handler'
          ? { ...invocation, status: 'skipped' as const }
          : invocation,
      ),
      {
        invocationKey: key('handler-stop'),
        nodeId: 'handler-stop',
        status: 'succeeded' as const,
        attemptNumber: 1,
        output: { kind: 'inline' as const, attemptId: id },
      },
    ],
    admittedInvocationKeys: [
      ...checkpoint.admittedInvocationKeys,
      key('handler-stop'),
    ],
  };
  await expect(
    advanceWorkflow({
      runId: id,
      workflowVersionId: version,
      executable: f.executable,
      checkpoint: corrupted,
      occurredAt: at,
      maximumAdmissions: 5,
      signal: new AbortController().signal,
    }),
  ).rejects.toMatchObject({ code: 'workflow_identity_invalid' });
});
