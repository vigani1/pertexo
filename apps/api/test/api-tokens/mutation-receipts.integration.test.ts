import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { apiTokenCreateResponseSchema } from '@pertexo/contracts';
import { betterAuthIntegrationEnabled } from '../support/better-auth/real-api.support.js';
import { useQualificationApi, type World } from './qualification/fixture.js';

type Command = Readonly<{
  method: 'POST' | 'PUT';
  path: string;
  payload: object;
  changed?: object;
  status: number;
  otherStatus: number;
}>;
const commands: Record<string, (world: World) => Command> = {
  lifecycle: (w) => ({
    method: 'POST',
    path: `${w.base}/workflows/${w.workflowId}/archive`,
    payload: { expectedLifecycleRevision: 1 },
    changed: { expectedLifecycleRevision: 999 },
    status: 202,
    otherStatus: 409,
  }),
  pause: (w) => ({
    method: 'PUT',
    path: `${w.base}/workflows/${w.workflowId}/auto-pause`,
    payload: {
      enabled: true,
      thresholdOverride: 7,
      expectedSettingsRevision: 1,
    },
    changed: {
      enabled: true,
      thresholdOverride: 8,
      expectedSettingsRevision: 1,
    },
    status: 200,
    otherStatus: 409,
  }),
  schedule: (w) => ({
    method: 'POST',
    path: `${w.schedule.endpoint}/disable`,
    payload: {},
    status: 200,
    otherStatus: 200,
  }),
  webhook: (w) => ({
    method: 'POST',
    path: `${w.webhook.endpoint}/provision`,
    payload: {},
    status: 200,
    otherStatus: 409,
  }),
  variables: (w) => ({
    method: 'PUT',
    path: `${w.base}/variables`,
    payload: { expectedRevision: w.variableRevision, values: { REGION: 'eu' } },
    changed: { expectedRevision: w.variableRevision, values: { REGION: 'us' } },
    status: 200,
    otherStatus: 409,
  }),
  tags: (w) => ({
    method: 'POST',
    path: `${w.base}/workflows/${w.workflowId}/tags`,
    payload: { expectedOrganizationRevision: 1, tagIds: [w.tagId] },
    changed: { expectedOrganizationRevision: 1, tagIds: [] },
    status: 200,
    otherStatus: 409,
  }),
};
function publicResult(value: Record<string, unknown>) {
  const {
    replayed: _replayed,
    endpointKey: _endpointKey,
    signingSecret: _signingSecret,
    ...result
  } = value;
  return result;
}
describe.runIf(betterAuthIntegrationEnabled)(
  'each new mutation receipt family',
  () => {
    const { api, setup } = useQualificationApi();
    it.each(Object.keys(commands))(
      '%s replays exactly under current authority and keeps credentials separate',
      async (family) => {
        const w = await setup(),
          key = randomUUID();
        const scopes = [
          'workflow:read',
          'workflow:update',
          'workflow:publish',
          'workspace:read',
          'variable:manage',
        ] as const;
        const first = await w.credential(scopes);
        const other = await api.send('POST', `${w.base}/api-tokens`, {
          browser: w.browser,
          headers: { 'idempotency-key': randomUUID() },
          payload: { name: 'Second receipt caller', scopes },
        });
        expect(other.statusCode, other.payload).toBe(201);
        const token = apiTokenCreateResponseSchema.parse(other.json());
        if (token.replayed) throw new Error('Fresh credential replayed');
        const build = commands[family];
        if (build === undefined) throw new Error('Command missing');
        const command = build(w);
        const send = (
          headers: Record<string, string>,
          payload = command.payload,
          browser?: typeof w.browser,
        ) =>
          api.send(command.method, command.path, {
            headers: { ...headers, 'idempotency-key': key },
            ...(browser === undefined ? {} : { browser }),
            payload,
          });
        const before = (
          await api
            .database()
            .query<{ id: string }>(
              'select id from app.idempotency_records where workspace_id=$1',
              [w.workspaceId],
            )
        ).rows.map((row) => row.id);
        const accepted = await send(first);
        expect(accepted.statusCode, accepted.payload).toBe(command.status);
        expect(accepted.json()).toMatchObject({ replayed: false });
        const replay = await send(first);
        expect(replay.statusCode, replay.payload).toBe(command.status);
        expect(replay.json()).toMatchObject({ replayed: true });
        expect(publicResult(replay.json<Record<string, unknown>>())).toEqual(
          publicResult(accepted.json<Record<string, unknown>>()),
        );
        if (family === 'webhook') {
          expect(accepted.json()).toHaveProperty('endpointKey');
          expect(replay.json()).not.toHaveProperty('endpointKey');
          expect(replay.json()).not.toHaveProperty('signingSecret');
        }
        if (command.changed !== undefined)
          expect((await send(first, command.changed)).statusCode).toBe(409);
        const {
          rows: [receipt],
        } = await api
          .database()
          .query<{ id: string }>(
            'select id from app.idempotency_records where workspace_id=$1 and id<>all($2::uuid[])',
            [w.workspaceId, before],
          );
        if (receipt === undefined)
          throw new Error('Accepted command omitted its receipt');
        for (const caller of [
          () => send({ authorization: `Bearer ${token.secret}` }),
          () => send({}, command.payload, w.browser),
        ]) {
          const response = await caller();
          expect(response.statusCode, response.payload).toBe(
            command.otherStatus,
          );
          if (response.statusCode === 200)
            expect(response.json()).toMatchObject({ replayed: false });
          expect(response.json()).not.toHaveProperty('endpointKey');
          expect(response.json()).not.toHaveProperty('signingSecret');
        }
        // The token's own receipt stays usable after other callers have been refused or admitted independently.
        expect((await send(first)).statusCode).toBe(command.status);
        // Damage the stored result only after proving ordinary replay/current authority.
        await api
          .database()
          .query(
            'update app.idempotency_records set result_ref=\'{"private-damaged-receipt":true}\' where id=$1',
            [receipt.id],
          );
        const damaged = await send(first);
        expect(damaged.json()).not.toHaveProperty('errors');
        expect(damaged.payload).not.toContain('private-damaged-receipt');
        if (family === 'webhook') {
          expect(damaged.statusCode, damaged.payload).toBe(200);
          expect(damaged.json()).toMatchObject({ replayed: true });
          expect(publicResult(damaged.json<Record<string, unknown>>())).toEqual(
            publicResult(accepted.json<Record<string, unknown>>()),
          );
          expect(damaged.json()).not.toHaveProperty('endpointKey');
          expect(damaged.json()).not.toHaveProperty('signingSecret');
        } else expect(damaged.statusCode, damaged.payload).toBe(409);
        const tokenId = first.authorization.split('.')[2];
        if (tokenId === undefined) throw new Error('Token id missing');
        const revoked = await api.send(
          'POST',
          `${w.base}/api-tokens/${tokenId}/revoke`,
          {
            browser: w.browser,
            headers: { 'idempotency-key': randomUUID() },
            payload: {},
          },
        );
        expect(revoked.statusCode, revoked.payload).toBe(200);
        expect((await send(first)).statusCode).toBe(401);
      },
    );

    it('keeps paused-workflow resume receipts private and never resumes a newer pause on replay', async () => {
      const w = await setup(),
        path = `${w.base}/workflows/${w.workflowId}/resume`,
        key = randomUUID();
      const first = await w.credential(['workflow:publish']);
      const issued = await api.send('POST', `${w.base}/api-tokens`, {
        browser: w.browser,
        headers: { 'idempotency-key': randomUUID() },
        payload: { name: 'Another pause caller', scopes: ['workflow:publish'] },
      });
      expect(issued.statusCode, issued.payload).toBe(201);
      const second = apiTokenCreateResponseSchema.parse(issued.json());
      if (second.replayed) throw new Error('Fresh token replayed');
      const pause = (revision: string) =>
        api
          .database()
          .query(
            `update app.workflows set trigger_pause_state='paused',trigger_paused_at=clock_timestamp(),trigger_pause_reason='consecutive_failures',trigger_pause_failures=10,trigger_pause_last_run_id=$2,trigger_pause_revision=$3 where id=$1`,
            [w.workflowId, randomUUID(), revision],
          );
      await pause('9007199254740993');
      const send = (
        headers: Record<string, string>,
        revision = '9007199254740993',
        browser?: typeof w.browser,
        commandKey = key,
      ) =>
        api.send('POST', path, {
          headers: { ...headers, 'idempotency-key': commandKey },
          ...(browser === undefined ? {} : { browser }),
          payload: { expectedPauseRevision: revision },
        });
      const accepted = await send(first);
      expect(accepted.statusCode, accepted.payload).toBe(200);
      expect(accepted.json()).toMatchObject({
        settings: { pauseState: 'none', pauseRevision: '9007199254740994' },
        replayed: false,
      });
      await pause('9007199254740995');
      const replay = await send(first);
      expect(replay.statusCode, replay.payload).toBe(200);
      expect(replay.json()).toMatchObject({ replayed: true });
      expect(publicResult(replay.json<Record<string, unknown>>())).toEqual(
        publicResult(accepted.json<Record<string, unknown>>()),
      );
      for (const caller of [
        () => send({ authorization: `Bearer ${second.secret}` }),
        () => send({}, '9007199254740993', w.browser),
        () => send(first, '9007199254740995'),
      ]) {
        const refused = await caller();
        expect(refused.statusCode, refused.payload).toBe(409);
      }
      expect(
        (
          await api
            .database()
            .query(
              'select trigger_pause_state,trigger_pause_revision::text from app.workflows where id=$1',
              [w.workflowId],
            )
        ).rows,
      ).toEqual([
        {
          trigger_pause_state: 'paused',
          trigger_pause_revision: '9007199254740995',
        },
      ]);
      const resumed = await send(
        first,
        '9007199254740995',
        undefined,
        randomUUID(),
      );
      expect(resumed.statusCode, resumed.payload).toBe(200);
      expect(resumed.json()).toMatchObject({
        settings: { pauseState: 'none', pauseRevision: '9007199254740996' },
      });
    });
  },
);
