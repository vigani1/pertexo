import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  createWorkflowLifecycleApiFixture,
  closeWorkflowLifecycleApiFixture,
  mutationHeaders,
  workflowLifecycleIntegrationEnabled,
  type WorkflowLifecycleApiFixture,
} from '../lifecycle.support.js';
import { previousResponses } from './pre-j4-responses.fixture.js';

let fixture: WorkflowLifecycleApiFixture;
beforeAll(async () => {
  if (workflowLifecycleIntegrationEnabled)
    fixture = await createWorkflowLifecycleApiFixture();
});
afterAll(async () => {
  if (workflowLifecycleIntegrationEnabled)
    await closeWorkflowLifecycleApiFixture(fixture);
});

it.skipIf(!workflowLifecycleIntegrationEnabled)(
  'keeps default reads decodable by the previous release and exposes additions only on request',
  async () => {
    const session = await fixture.login('builder');
    const base = `/v1/workspaces/${fixture.workspaceId}/workflows`;
    const get = (path: string) =>
      fixture.application.inject({
        method: 'GET',
        url: path,
        headers: { cookie: session.cookieHeader },
      });
    const list = await get(base);
    expect(list.statusCode).toBe(200);
    expect(() => previousResponses.list.parse(list.json())).not.toThrow();
    const draft = await get(`${base}/${fixture.ids.unpublished}/draft`);
    expect(draft.statusCode).toBe(200);
    expect(() => previousResponses.draft.parse(draft.json())).not.toThrow();
    const versions = await get(`${base}/${fixture.ids.published}/versions`);
    expect(versions.statusCode).toBe(200);
    expect(() =>
      previousResponses.versions.parse(versions.json()),
    ).not.toThrow();
    const summarized = await get(`${base}?include=listSummary`);
    expect(summarized.statusCode).toBe(200);
    expect(summarized.json<{ items: object[] }>().items[0]).toHaveProperty(
      'listSummary',
    );
    const digested = await get(
      `${base}/${fixture.ids.unpublished}/draft?include=graphDigest`,
    );
    expect(digested.statusCode).toBe(200);
    expect(digested.json()).toHaveProperty('graphDigest');
    expect(digested.headers.etag).toBe(draft.headers.etag);
    const digestedVersions = await get(
      `${base}/${fixture.ids.published}/versions?include=graphDigest`,
    );
    expect(digestedVersions.statusCode).toBe(200);
    expect(
      digestedVersions.json<{ items: object[] }>().items[0],
    ).toHaveProperty('graphDigest');
    const saved = await fixture.application.inject({
      method: 'PUT',
      url: `${base}/${fixture.ids.unpublished}/draft`,
      headers: mutationHeaders(session, {
        'if-match': String(draft.headers.etag),
      }),
      payload: { graph: draft.json<{ graph: unknown }>().graph },
    });
    expect(saved.statusCode, saved.payload).toBe(200);
    expect(() => previousResponses.draft.parse(saved.json())).not.toThrow();
  },
);
