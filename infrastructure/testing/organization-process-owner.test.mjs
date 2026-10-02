import assert from 'node:assert/strict';
import { test } from 'node:test';
import { organizationStartupFailure } from './organization-process-protocol.mjs';
import {
  closeOrganizationQualification,
  deadline,
} from './organization-process-owner.mjs';

test('failed shutdown barrier preserves both owned resources and compiled artifacts', async () => {
  const events = [];
  await assert.rejects(
    closeOrganizationQualification(
      [
        {
          close: async () => {
            throw new Error('unconfirmed');
          },
        },
      ],
      { close: async () => events.push('drop') },
      [{ close: async () => events.push('artifact') }],
    ),
    /unconfirmed/u,
  );
  assert.deepEqual(events, []);
});
test('all process barriers precede database/Redis and artifact cleanup', async () => {
  const events = [];
  await closeOrganizationQualification(
    [{ close: async () => events.push('process') }],
    { close: async () => events.push('resources') },
    [{ close: async () => events.push('artifact') }],
  );
  assert.deepEqual(events, ['process', 'resources', 'artifact']);
});
test('cleanup failure preserves artifact evidence', async () => {
  let removed = false;
  await assert.rejects(
    closeOrganizationQualification(
      [],
      {
        close: async () => {
          throw new Error('cleanup');
        },
      },
      [
        {
          close: async () => {
            removed = true;
          },
        },
      ],
    ),
    /cleanup/u,
  );
  assert.equal(removed, false);
});
test('deadline fails closed without forwarding secret diagnostics', async () => {
  await assert.rejects(
    deadline(new Promise(() => undefined), 1, 'public deadline'),
    { message: 'public deadline' },
  );
});

test('only the frozen migration-head readiness literal proves old-image incompatibility', () => {
  assert.equal(
    organizationStartupFailure(
      new Error('Database migration head is incompatible'),
    ),
    'migration-head-incompatible',
  );
  for (const error of [
    new Error('schema migration incompatible credentials'),
    new Error('Workflow authoring schema is incompatible'),
    'Database migration head is incompatible',
    null,
  ])
    assert.equal(organizationStartupFailure(error), 'startup-failed');
});
