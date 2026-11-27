import type { Page } from '../support/fixtures';
import {
  currentEtag,
  remoteDraft,
  workflowId,
  workspaceId,
} from '../workflow-editor/support';
import { at, edge, invoiceGraph, node } from './core-flow-invoice-graph';

const compatibility = {
  compatible: true,
  fingerprint: `wf-compat:sha256:${'0'.repeat(64)}`,
  issues: [],
};

/**
 * The assistant's one proposal for the invoice workflow: after Send receipt,
 * a Slack step posts to #finance. Answers the disclosure read and the
 * request with it.
 */
export async function installAssistantProposal(page: Page) {
  const graph = invoiceGraph();
  const base = {
    workflowId,
    revision: 1,
    graph,
    compatibility,
    updatedAt: at(5),
  };
  const draft = {
    ...base,
    graph: {
      ...graph,
      nodes: [
        ...graph.nodes,
        node('slack', 'slack.send_message', 'Post to #finance', [1800, 200]),
      ],
      edges: [...graph.edges, edge('receipt', 'slack')],
    },
  };
  await page.route(
    `**/v1/workspaces/${workspaceId}/workflows/${workflowId}/draft/proposal`,
    (route) =>
      route.fulfill({
        json:
          route.request().method() === 'GET'
            ? {
                kind: 'ready',
                connectionName: 'Workspace AI',
                host: 'models.example.test',
                model: 'reasoning-large',
                confirmation: 'confirmed',
              }
            : {
                kind: 'inspected',
                base,
                draft,
                representationTag: currentEtag(remoteDraft(graph)),
                usage: {
                  kind: 'complete',
                  model: 'reasoning-large',
                  inputTokens: 1,
                  outputTokens: 1,
                },
                validation: {
                  valid: true,
                  issues: [],
                  compatibility,
                  currentPublication: null,
                },
              },
      }),
  );
}
