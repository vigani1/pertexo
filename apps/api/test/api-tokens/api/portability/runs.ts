import { randomUUID, createHash } from 'node:crypto';
import { canonicalJson } from '@pertexo/workflow-model';
import { expect } from 'vitest';
import {
  workflowPublishResponseSchema,
  workflowRunStartResponseSchema,
} from '@pertexo/contracts';
import type { createAutomationApiFixture } from '../fixture.js';
import type { TokenWorkspace } from './contract.js';

export async function qualifyCredentialRuns(
  caseFixture: ReturnType<typeof createAutomationApiFixture>,
  evidence: TokenWorkspace,
) {
  const { api } = caseFixture;
  const { base, workflowId, saved, headers, first, second, browser } = evidence;
  for (const suffix of ['', '/draft', '/versions']) {
    expect(
      (
        await api.send('GET', `${base}/workflows/${workflowId}${suffix}`, {
          headers,
        })
      ).statusCode,
    ).toBe(200);
  }

  const publishKey = randomUUID();
  const published = await api.send(
    'POST',
    `${base}/workflows/${workflowId}/publish`,
    {
      headers: {
        ...headers,
        'idempotency-key': publishKey,
        'if-match': String(saved.headers.etag),
      },
    },
  );
  expect(published.statusCode).toBe(200);
  const versionId = workflowPublishResponseSchema.parse(published.json())
    .version.id;
  const replay = await api.send(
    'POST',
    `${base}/workflows/${workflowId}/publish`,
    {
      headers: {
        ...headers,
        'idempotency-key': publishKey,
        'if-match': String(saved.headers.etag),
      },
    },
  );
  expect(replay.statusCode).toBe(200);
  expect(workflowPublishResponseSchema.parse(replay.json()).version.id).toBe(
    versionId,
  );
  const deniedVersion = await api.send(
    'POST',
    `${base}/workflows/${workflowId}/runs`,
    {
      headers: { ...headers, 'idempotency-key': randomUUID() },
      payload: { expectedPublishedVersionId: randomUUID() },
    },
  );
  expect(deniedVersion.statusCode).toBe(409);
  expect(deniedVersion.json<{ code: string }>().code).toBe(
    'workflow.published_version_conflict',
  );
  const key = randomUUID();
  const payload = {
    input: { value: 'actual token input' },
    expectedPublishedVersionId: versionId,
  };
  const start = await api.send('POST', `${base}/workflows/${workflowId}/runs`, {
    headers: { ...headers, 'idempotency-key': key },
    payload,
  });
  const startProblem = start.json<{
    code?: string;
    detail?: string;
    issues?: unknown;
  }>();
  expect(
    start.statusCode,
    JSON.stringify({
      code: startProblem.code,
      detail: startProblem.detail,
      issues: startProblem.issues,
    }),
  ).toBe(202);
  const started = workflowRunStartResponseSchema.parse(start.json());
  const retried = await api.send(
    'POST',
    `${base}/workflows/${workflowId}/runs`,
    { headers: { ...headers, 'idempotency-key': key }, payload },
  );
  expect(retried.statusCode).toBe(202);
  expect(workflowRunStartResponseSchema.parse(retried.json()).run.id).toBe(
    started.run.id,
  );
  const other = await api.send('POST', `${base}/workflows/${workflowId}/runs`, {
    headers: {
      authorization: `Bearer ${second.secret}`,
      'idempotency-key': key,
    },
    payload,
  });
  expect(other.statusCode).toBe(202);
  expect(workflowRunStartResponseSchema.parse(other.json()).run.id).not.toBe(
    started.run.id,
  );
  const weakKey = createHash('sha256')
    .update(canonicalJson({ kind: 'api_key', tokenId: first.token.id, key }))
    .digest('hex');
  const sessionRun = await api.send(
    'POST',
    `${base}/workflows/${workflowId}/runs`,
    { browser, headers: { 'idempotency-key': weakKey }, payload },
  );
  expect(sessionRun.statusCode).toBe(202);
  expect(
    workflowRunStartResponseSchema.parse(sessionRun.json()).run.id,
  ).not.toBe(started.run.id);
  expect(
    (await api.send('GET', `${base}/runs/${started.run.id}`, { headers }))
      .statusCode,
  ).toBe(200);
  expect(
    (
      await api.send('POST', `${base}/runs/${started.run.id}/cancel`, {
        headers,
        payload: {},
      })
    ).statusCode,
  ).toBe(200);

  return { payload, started };
}
