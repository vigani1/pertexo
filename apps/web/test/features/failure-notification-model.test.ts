import { describe, expect, it } from 'vitest';
import {
  channelKey,
  channelLookups,
  channelNamesFrom,
  describeChannel,
} from '@/features/failure-notifications/model/channel-names';
import { describeDestination } from '@/features/failure-notifications/model/destination-copy';

const slack = (connectionId: string, channelId: string) => ({
  config: { kind: 'slack' as const, connectionId, channelId },
});

describe('Slack channel names on alert destinations', () => {
  it('asks once per connection for its distinct channels, ten at a time', () => {
    const many = Array.from({ length: 12 }, (_, index) =>
      slack('b', `C${String(index).padStart(2, '0')}`),
    );
    expect(
      channelLookups([
        ...many,
        slack('a', 'G1'),
        slack('a', 'G1'),
        {
          config: {
            kind: 'email' as const,
            connectionId: 'a',
            toEmail: 'ops@example.test',
          },
        },
      ]),
    ).toEqual([
      { connectionId: 'a', channelIds: ['G1'] },
      {
        connectionId: 'b',
        channelIds: many.slice(0, 10).map(({ config }) => config.channelId),
      },
      { connectionId: 'b', channelIds: ['C10', 'C11'] },
    ]);
  });

  it('keys answers and failures by connection and channel, and waits for the rest', () => {
    const lookups = [
      { connectionId: 'a', channelIds: ['C1', 'D2'] },
      { connectionId: 'b', channelIds: ['C3'] },
      { connectionId: 'c', channelIds: ['C4'] },
    ];
    const names = channelNamesFrom(lookups, [
      {
        isError: false,
        data: {
          items: [
            { channelId: 'C1', status: 'resolved', name: 'ops' },
            { channelId: 'D2', status: 'unresolved', reason: 'not_a_channel' },
          ],
        },
      },
      { isError: true, data: undefined },
      { isError: false, data: undefined },
    ]);

    expect(names.get(channelKey('a', 'C1'))).toEqual({
      status: 'resolved',
      name: 'ops',
    });
    expect(names.get(channelKey('b', 'C3'))).toEqual({
      status: 'unresolved',
      reason: 'lookup_failed',
    });
    expect(names.has(channelKey('c', 'C4'))).toBe(false);
    expect(describeChannel('C4', undefined)).toEqual({
      target: '#C4',
      note: undefined,
    });
    expect(describeChannel('D2', names.get(channelKey('a', 'D2')))).toEqual({
      target: '#D2',
      note: 'Showing the channel ID. Direct messages don’t have channel names.',
    });
  });

  it('lets a connection problem explain a missing name instead of a second note', () => {
    const names = new Map([
      [
        channelKey('a', 'C1'),
        { status: 'unresolved', reason: 'connection_unavailable' } as const,
      ],
    ]);
    const connection = {
      id: 'a',
      workspaceId: 'w',
      providerKey: 'slack' as const,
      name: 'Ops bot',
      authType: 'slack_bot_token' as const,
      secretVersionId: 's',
      health: { lastTestedAt: null, lastHealthyAt: null, lastErrorCode: null },
      createdAt: '2026-09-25T10:00:00.000Z',
      updatedAt: '2026-09-25T10:00:00.000Z',
    };

    expect(
      describeDestination(
        slack('a', 'C1'),
        [{ ...connection, status: 'revoked' }],
        names,
      ),
    ).toEqual({
      label: '#C1 via Ops bot',
      connectionProblem: 'Ops bot was revoked, so these alerts can’t be sent.',
      channelNote: undefined,
    });
    expect(
      describeDestination(
        slack('a', 'C1'),
        [{ ...connection, status: 'active' }],
        names,
      ).channelNote,
    ).toBe(
      'Showing the channel ID. This connection can’t look up channel names.',
    );
  });
});
