import { noUnsignaledPoll } from './no-unsignaled-poll.mjs';
import { ratchetCases, tester } from './rule-tester.mjs';

const filename = 'apps/web/test/polls.test.ts';
const poll = [{ messageId: 'poll' }];

tester.run('no-unsignaled-poll', noUnsignaledPoll, {
  valid: [
    {
      name: 'polling text on screen',
      code: `await vi.waitFor(() => expect(screen.getByText('Saved')).toBeTruthy());`,
      filename,
    },
    {
      name: 'polling a stored row through a read',
      code: `await expect.poll(() => rowsFor(runId)).toHaveLength(1);`,
      filename,
    },
    {
      name: 'a callback that does more than read a recorder',
      code: `await vi.waitFor(() => { const rows = read(); expect(rows).toEqual([]); });`,
      filename,
    },
    {
      name: 'a ref, which React updates, not a recorder',
      code: `await vi.waitFor(() => expect(ref.current).toHaveLength(2));`,
      filename,
    },
  ],
  invalid: [
    {
      name: 'waiting for a spy to be called',
      code: `await vi.waitFor(() => expect(send).toHaveBeenCalled());`,
      filename,
      errors: poll,
    },
    {
      name: 'waiting for a spy not to be called',
      code: `await vi.waitFor(() => expect(send).not.toHaveBeenCalledWith('x'));`,
      filename,
      errors: poll,
    },
    {
      name: "polling a spy's recorded calls",
      code: `await expect.poll(() => fetch.mock.calls.length).toBe(1);`,
      filename,
      errors: poll,
    },
    {
      name: "polling a spy's last call",
      code: `await expect.poll(() => send.mock.lastCall).toEqual(['x']);`,
      filename,
      errors: poll,
    },
    {
      name: 'polling a recorder array to a length',
      code: `await expect.poll(() => requests).toHaveLength(2);`,
      filename,
      errors: poll,
    },
    {
      name: "waiting on a recorder's size",
      code: `await vi.waitFor(() => { expect(fake.sent.length).toBe(2); });`,
      filename,
      errors: poll,
    },
  ],
});

tester.run(
  'no-unsignaled-poll ratchet',
  noUnsignaledPoll,
  ratchetCases({
    filename,
    count: 1,
    code: `await vi.waitFor(() => expect(send).toHaveBeenCalled());`,
  }),
);
