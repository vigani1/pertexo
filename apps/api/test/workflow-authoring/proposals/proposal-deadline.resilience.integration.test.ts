import { DRAFT_PROPOSAL_TIMING } from '@pertexo/contracts';
import type { WorkflowGraph } from '@pertexo/workflow-model';
import { beforeAll, describe, expect, it } from 'vitest';
import { useProposalApi } from './proposal-api.fixture.js';
import {
  betterAuthIntegrationEnabled,
  type Browser,
} from '../../support/better-auth/real-api.support.js';

const manual = {
  id: 'manual',
  definition: { key: 'core.manual', version: 1 },
  configVersion: 1,
  position: { x: 0, y: 0 },
  config: {},
  inputMappings: {},
  connectionRefs: {},
};

function requestDraft(config: Record<string, string>): WorkflowGraph {
  return {
    nodes: [
      manual,
      {
        ...manual,
        id: 'request',
        definition: { key: 'http.request', version: 1 },
        config,
      },
    ],
    edges: [
      {
        id: 'send-request',
        source: { nodeId: manual.id, port: 'out' },
        target: { nodeId: 'request', port: 'in' },
      },
    ],
    settings: {},
  };
}

// It waits out the whole proposal budget, so it runs in the resilience lane.
describe.runIf(betterAuthIntegrationEnabled)('draft proposal deadline', () => {
  const proposals = useProposalApi('proposal_deadline');
  let owner: Browser;
  let workspace: string;

  beforeAll(async () => {
    owner = (await proposals.newUser()).browser;
    workspace = (await proposals.workspaceFor(owner)).path;
  });

  it('times out a correction on the original request deadline', async () => {
    const path = await proposals.workflow(workspace, owner);
    const firstReplyMillis = 4_000;
    const start = proposals.requests.length;
    const startedAt = performance.now();
    const url = 'https://orders.example.test';
    const result = await proposals.propose(
      path,
      [
        {
          graph: requestDraft({ url, method: 'INVALID' }),
          waitMillis: firstReplyMillis,
        },
        { graph: requestDraft({ url }), hold: true },
      ],
      owner,
    );
    expect(result).toMatchObject({ kind: 'timeout', rounds: 1 });
    expect(proposals.requests.slice(start)).toHaveLength(2);
    expect(performance.now() - startedAt).toBeLessThan(
      DRAFT_PROPOSAL_TIMING.generationMillis + firstReplyMillis / 2,
    );
  });
});
