import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, expect, it } from 'vitest';

import { OAUTH2_STAND_IN_DESCRIPTION } from '../../../../infrastructure/testing/oauth2-stand-in.mjs';
import {
  describeOAuth2,
  startOAuth2Harness,
  useOAuth2Timeouts,
  type OAuth2Harness,
} from '../support/oauth2/harness.js';
import {
  startTraceCollector,
  TRACE_ENVIRONMENT,
  type TraceCollector,
} from '../support/oauth2/traces.js';

useOAuth2Timeouts();

describeOAuth2('where OAuth2 secrets never appear', () => {
  let harness: OAuth2Harness;
  let traces: TraceCollector;

  beforeAll(async () => {
    traces = await startTraceCollector();
    harness = await startOAuth2Harness('secrets', {
      environment: {
        LOG_LEVEL: 'debug',
        ...TRACE_ENVIRONMENT,
        OTEL_EXPORTER_OTLP_ENDPOINT: traces.origin,
      },
    });
  });
  afterAll(async () => {
    await harness.close();
    await traces.close();
  });

  /** Everything the plan names: every stored row a person can reach, and every process's output. */
  const searchEverywhere = async (
    responses: readonly string[],
    runIds: readonly string[],
    connectionId: string,
  ): Promise<Record<string, string>> => {
    const [events] = await harness.stack.sql<{ text: string }>(
      `select coalesce(string_agg(to_jsonb(e)::text,' '),'') as text
         from app.connection_events e where connection_id=$1`,
      [connectionId],
    );
    const [audit] = await harness.stack.sql<{ text: string }>(
      `select coalesce(string_agg(to_jsonb(a)::text,' '),'') as text
         from app.audit_events a where target_id=$1`,
      [connectionId],
    );
    const [runEvents] = await harness.stack.sql<{ text: string }>(
      `select coalesce(string_agg(to_jsonb(e)::text,' '),'') as text
         from app.run_events e where workflow_run_id = any($1::uuid[])`,
      [runIds],
    );
    const stepOutput = (
      await Promise.all(runIds.map((runId) => harness.storedOutput(runId)))
    ).join(' ');
    return {
      responses: responses.join('\n'),
      connectionEvents: events?.text ?? '',
      audit: audit?.text ?? '',
      runEvents: runEvents?.text ?? '',
      stepOutput,
      apiLogs: harness.stack.apiProcess.logs.map(({ text }) => text).join('\n'),
      workerLogs: harness.stack.worker.logs.map(({ text }) => text).join('\n'),
      traces: traces.received(),
    };
  };

  const expectAbsent = (
    places: Readonly<Record<string, string>>,
    secrets: Readonly<Record<string, string>>,
  ): void => {
    const found: string[] = [];
    for (const [place, text] of Object.entries(places))
      for (const [name, secret] of Object.entries(secrets))
        if (secret !== '' && text.includes(secret))
          found.push(`${name} in ${place}`);
    expect(found).toEqual([]);
  };

  // S20, S13, proof list: a full journey, then a failed one, searched everywhere.
  it('S20 no secret, token, code, state or verifier appears anywhere', async () => {
    const { standIn } = harness;
    const owner = await harness.newOwner();
    const responses: string[] = [];
    const keep = <Response extends { json: unknown }>(response: Response) => {
      responses.push(JSON.stringify(response.json));
      return response;
    };
    const connection = await harness.create(owner, 'rotating');
    responses.push(JSON.stringify(connection.body));
    // The start response is the one place the state must be: it is in the address
    // the person opens. It is searched below for everything else.
    const started = await harness.start(owner.api, owner, connection.id);
    const startText = JSON.stringify(started.json);
    const bindingCookie =
      owner.api.cookieValue(
        `pertexo_oauth2_${connection.id.replaceAll('-', '')}`,
      ) ?? '';
    const callbackUrl = await harness.decide(
      harness.authorizationUrl(started),
      'approve',
    );
    const url = new URL(callbackUrl);
    const landing = await harness.land(owner.api, callbackUrl);
    expect(landing.result).toBe('connected');
    responses.push(landing.location ?? '');
    responses.push(JSON.stringify(landing.headers.getSetCookie()));
    keep(await harness.read(owner.api, owner, connection.id));

    // A run that renews, one that sees a 401, and a test.
    await harness.expireToken(connection.id);
    const renewed = await harness.run(owner, {
      connectionId: connection.id,
      method: 'GET',
      url: harness.apiUrl(),
    });
    expect((await harness.finish(renewed)).status).toBe('succeeded');
    keep(
      await harness.test(
        owner,
        connection.id,
        'https://api.public.example.test/api',
      ),
    );

    // A failed journey: the service refuses the refresh, in its own words.
    standIn.revoke(connection.clientId);
    await harness.expireToken(connection.id);
    const failed = await harness.run(owner, {
      connectionId: connection.id,
      method: 'POST',
      url: harness.apiUrl(),
    });
    expect((await harness.finish(failed)).status).toBe('failed');
    keep(await harness.read(owner.api, owner, connection.id));
    keep(
      await owner.api.call(
        'GET',
        `/v1/workspaces/${owner.workspaceId}/runs/${failed}`,
      ),
    );

    // Give batched traces time to leave.
    await new Promise((resolve) => setTimeout(resolve, 2_000));

    const issued = standIn.tokenRequests(connection.clientId);
    const exchange = issued.find(
      ({ form }) => form?.grant_type === 'authorization_code',
    );
    const refreshes = issued
      .map(({ form }) => form?.refresh_token ?? '')
      .filter((value) => value !== '');
    const apiTokens = standIn
      .apiCalls(connection.clientId)
      .map(({ headers }) =>
        String(headers.authorization).replace('Bearer ', ''),
      );
    expect(apiTokens.length).toBeGreaterThan(0);
    expect(refreshes.length).toBeGreaterThan(0);
    expect(exchange?.form?.code_verifier).toBeTruthy();

    const state = url.searchParams.get('state') ?? '';
    const secrets: Record<string, string> = {
      clientSecret: connection.clientSecret,
      code: url.searchParams.get('code') ?? '',
      state,
      stateSecret: state.split('.')[1] ?? '',
      verifier: exchange?.form?.code_verifier ?? '',
      binding: bindingCookie,
      description: OAUTH2_STAND_IN_DESCRIPTION,
      ...Object.fromEntries(
        refreshes.map((value, index) => [`refresh${String(index)}`, value]),
      ),
      ...Object.fromEntries(
        apiTokens.map((value, index) => [`access${String(index)}`, value]),
      ),
    };
    expect(secrets.code).not.toBe('');
    expect(secrets.state).not.toBe('');

    const places = await searchEverywhere(
      responses,
      [renewed, failed],
      connection.id,
    );
    // Proves the search looks at real output, so an empty result means something.
    expect(places.apiLogs).toContain('"level"');
    expect(places.workerLogs).toContain('"level"');
    expect(places.connectionEvents).toContain('connection.oauth2_authorized');
    expect(places.traces).toContain('resourceSpans');
    expect(secrets.binding).not.toBe('');
    expectAbsent(places, secrets);
    const {
      state: _inTheAddress,
      stateSecret: _ofTheAddress,
      ...others
    } = secrets;
    expectAbsent({ startResponse: startText }, others);
  });

  // S20: a client-credentials failure is the other way a secret could reach a log.
  it('S20 a refused client-credentials start keeps the secret out', async () => {
    const owner = await harness.newOwner();
    const connection = await harness.createServer(owner, 'invalid-client');
    const started = await harness.start(owner.api, owner, connection.id);
    expect(started.status).toBe(409);
    expectAbsent(
      await searchEverywhere([JSON.stringify(started.json)], [], connection.id),
      { clientSecret: connection.clientSecret },
    );
  });

  // S20: an API that echoes what it was sent must not put the token in the stored output.
  it('S20 the token is not in a step’s stored output', async () => {
    const owner = await harness.newOwner();
    const connection = await harness.connected(owner, 'non-rotating');
    const marker = randomUUID();
    const runId = await harness.run(owner, {
      connectionId: connection.id,
      method: 'GET',
      url: harness.apiUrl(`/api/echo?marker=${marker}`),
    });
    expect((await harness.finish(runId)).status).toBe('succeeded');
    const [call] = harness.standIn.apiCalls(connection.clientId);
    const token = String(call?.headers.authorization).replace('Bearer ', '');
    expect(token).toMatch(/^stand-in-at-/u);
    const stored = await harness.storedOutput(runId);
    // The echo really is stored, so the absence below means something.
    expect(stored).toContain(marker);
    expect(stored).toContain('[Redacted]');
    expect(stored).not.toContain(token);
  });

  // S20: the token a step renews to is new to the request, so only the renewal
  // client can mark it. An API echoing the repeat must not store it either.
  it('S20 a token renewed mid-step is not in the stored output', async () => {
    const owner = await harness.newOwner();
    const connection = await harness.connected(owner, 'api-401-once');
    await harness.ageToken(connection.id);
    const marker = randomUUID();
    const runId = await harness.run(owner, {
      connectionId: connection.id,
      method: 'GET',
      url: harness.apiUrl(`/api/echo?marker=${marker}`),
    });
    expect((await harness.finish(runId)).status).toBe('succeeded');
    const calls = harness.standIn.apiCalls(connection.clientId);
    expect(calls).toHaveLength(2);
    const renewed = String(calls[1]?.headers.authorization).replace(
      'Bearer ',
      '',
    );
    expect(renewed).toMatch(/^stand-in-at-/u);
    expect(calls[0]?.headers.authorization).not.toBe(
      calls[1]?.headers.authorization,
    );
    const stored = await harness.storedOutput(runId);
    expect(stored).toContain(marker);
    expect(stored).not.toContain(renewed);
  });
});
