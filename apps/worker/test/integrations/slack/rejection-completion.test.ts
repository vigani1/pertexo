import { expect, it } from 'vitest';
import { NodeExecutorFailure } from '@pertexo/node-sdk/server';
import { createSlackSendMessageExecutorRegistration } from '@pertexo/integrations/server';
import {
  runtime,
  invocation,
} from '../../../../../packages/integrations/test/support/slack-execution.js';
import { executorFailureCompletion } from '../../../src/attempts/delivery/executor-failure.js';

it.each(['token_expired', 'missing_scope', 'not_in_channel'])(
  'retains safe Slack %s guidance at worker completion',
  async (error) => {
    const state = runtime({ kind: 'rejected', error });
    const failure: unknown = await createSlackSendMessageExecutorRegistration({
      client: { sendMessage: state.sendMessage },
    })
      .execute(invocation(state.value))
      .catch((caught: unknown) => caught);
    if (!(failure instanceof NodeExecutorFailure)) throw failure;
    expect(executorFailureCompletion(failure)).toMatchObject({
      failureKind: 'failed',
      possiblyDispatched: false,
      safeErrorCode: `slack.${error}`,
      errorSummary: expect.stringMatching(/Slack/iu),
    });
  },
);
