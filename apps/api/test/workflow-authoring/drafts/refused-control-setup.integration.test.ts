import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  closeWorkflowLifecycleApiFixture,
  createWorkflowLifecycleApiFixture,
  mutationHeaders,
  type WorkflowLifecycleApiFixture,
  workflowLifecycleIntegrationEnabled,
} from '../lifecycle.support.js';

const describeIntegration = workflowLifecycleIntegrationEnabled
  ? describe
  : describe.skip;

const step = (
  id: string,
  key: string,
  x: number,
  extra: Readonly<Record<string, unknown>> = {},
) => ({
  id,
  definition: { key, version: 1 },
  position: { x, y: 0 },
  configVersion: 1,
  config: {},
  inputMappings: {},
  connectionRefs: {},
  ...extra,
});

/** `other` is not a Switch case port, so the Switch schema refuses this setup. */
const refusedSwitchGraph = {
  settings: { maxRunDurationMs: 60_000 },
  nodes: [
    step('manual', 'core.manual', 0),
    step('switch', 'core.switch', 10, {
      config: { cases: [{ id: 'other', equals: true }] },
      inputMappings: { value: { kind: 'literal', value: true } },
    }),
    step('terminate', 'core.terminate', 20),
  ],
  edges: [
    {
      id: 'manual-switch',
      source: { nodeId: 'manual', port: 'out' },
      target: { nodeId: 'switch', port: 'in' },
    },
    {
      id: 'switch-terminate',
      source: { nodeId: 'switch', port: 'other' },
      target: { nodeId: 'terminate', port: 'in' },
    },
  ],
};

describeIntegration('a draft whose control setup the schemas refuse', () => {
  let fixture: WorkflowLifecycleApiFixture;

  beforeEach(async () => {
    fixture = await createWorkflowLifecycleApiFixture();
  });

  afterEach(async () => {
    await closeWorkflowLifecycleApiFixture(fixture);
  });

  // audit-1030 follow-up 2: the comparison's compile throws, so this reads 422.
  it.fails(
    'still opens on a published workflow and reads as not matching it',
    async () => {
      const { application, ids, workspaceId } = fixture;
      const owner = await fixture.login('owner');
      const base = `/v1/workspaces/${workspaceId}/workflows/${ids.published}`;
      const current = await application.inject({
        method: 'GET',
        url: `${base}/draft`,
        headers: { cookie: owner.cookieHeader },
      });
      expect(current.statusCode, current.body).toBe(200);
      const saved = await application.inject({
        method: 'PUT',
        url: `${base}/draft`,
        headers: mutationHeaders(owner, {
          'if-match': String(current.headers.etag),
        }),
        payload: { graph: refusedSwitchGraph },
      });
      expect(saved.statusCode, saved.body).toBe(200);

      const opened = await application.inject({
        method: 'POST',
        url: `${base}/validate`,
        headers: mutationHeaders(owner),
        payload: {},
      });

      expect(opened.statusCode, opened.body).toBe(200);
      expect(opened.json()).toMatchObject({
        currentPublication: {
          versionId: ids.publishedVersion,
          versionNumber: 4,
          matchesDraft: false,
        },
      });
    },
  );
});
