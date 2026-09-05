import { describe, expect, it } from 'vitest';

import {
  encodeRunEventReference,
  encodeRunEventResync,
  runEventChannel,
} from '../src/run-event-notifications.js';

const workspaceId = '11111111-1111-4111-8111-111111111111';
const runId = '22222222-2222-4222-8222-222222222222';

describe('run event notification contract', () => {
  it('derives an opaque stable tenant/run channel', () => {
    const channel = runEventChannel(workspaceId, runId);
    expect(channel).toMatch(/^run-events:v1:[A-Za-z0-9_-]{43}$/u);
    expect(channel).toBe(runEventChannel(workspaceId, runId));
    expect(channel).not.toContain(workspaceId);
    expect(channel).not.toContain(runId);
  });

  it('encodes bounded event and resync messages', () => {
    expect(
      JSON.parse(encodeRunEventReference({ workspaceId, runId, sequence: 7 })),
    ).toEqual({ kind: 'event', workspaceId, runId, sequence: 7 });
    expect(JSON.parse(encodeRunEventResync({ workspaceId, runId }))).toEqual({
      kind: 'resync',
    });
    expect(() =>
      encodeRunEventReference({ workspaceId, runId, sequence: 0 }),
    ).toThrow();
  });
});
