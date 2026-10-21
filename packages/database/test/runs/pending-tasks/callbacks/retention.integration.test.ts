import { expect, it } from 'vitest';
import {
  callbacks,
  prepared,
  response,
  unchanged,
  enforceTestRetention,
} from './fixtures.js';
import { purgeTestWorkspace } from '../../../support/workflow-authoring.js';
import { terminal } from '../../values/fixtures.js';
it.each(['api', 'test'])(
  'removes prepared and early answered callbacks with %s run details while keeping live callbacks',
  async (trigger) => {
    const live = await prepared(trigger);
    const early = await prepared(trigger);
    await callbacks.respond({
      callback: early.callback,
      output: response,
      redactOutput: unchanged,
      signal: early.scope.signal,
    });
    const unopened = await prepared(trigger);
    await terminal(
      early.scope.runId,
      trigger === 'test' ? '8 days' : '31 days',
    );
    await terminal(
      unopened.scope.runId,
      trigger === 'test' ? '8 days' : '31 days',
    );
    await enforceTestRetention(2);
    expect(
      await callbacks.resolve(early.callback.tokenHash, early.scope.signal),
    ).toBeNull();
    expect(
      await callbacks.resolve(
        unopened.callback.tokenHash,
        unopened.scope.signal,
      ),
    ).toBeNull();
    expect(
      await callbacks.resolve(live.callback.tokenHash, live.scope.signal),
    ).toMatchObject({ id: live.callback.id });
  },
);

it('purges prepared and early answered callback hashes and responses with the workspace', async () => {
  const unopened = await prepared();
  const early = await prepared();
  await callbacks.respond({
    callback: early.callback,
    output: response,
    redactOutput: unchanged,
    signal: early.scope.signal,
  });
  await purgeTestWorkspace(unopened.scope.workspaceId, { pageSize: 100 });
  expect(
    await callbacks.resolve(unopened.callback.tokenHash, unopened.scope.signal),
  ).toBeNull();
  expect(
    await callbacks.resolve(early.callback.tokenHash, early.scope.signal),
  ).toBeNull();
}, 60_000);
