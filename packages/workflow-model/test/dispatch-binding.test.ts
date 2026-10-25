import { expect, it } from 'vitest';
import { publishesSlackBinding } from '../src/execution/dispatch-binding.js';

it('matches only the published Slack send node and its own connection, including loop bodies', () => {
  const node = {
    id: 'send',
    definition: { key: 'slack.send_message', version: 1 },
    connectionRefs: { slack_bot_token: 'connection' },
  };
  for (const nodes of [[node], [{ structured: { body: { nodes: [node] } } }]]) {
    expect(
      publishesSlackBinding({ graph: { nodes } }, 'send', 'connection'),
    ).toBe(true);
    expect(
      publishesSlackBinding({ graph: { nodes } }, 'other', 'connection'),
    ).toBe(false);
    expect(publishesSlackBinding({ graph: { nodes } }, 'send', 'other')).toBe(
      false,
    );
  }
  expect(
    publishesSlackBinding(
      {
        graph: {
          nodes: [
            { ...node, definition: { key: 'slack.send_message', version: 2 } },
          ],
        },
      },
      'send',
      'connection',
    ),
  ).toBe(false);
  expect(publishesSlackBinding(null, 'send', 'connection')).toBe(false);
});
