import {
  connectionResponseSchema,
  type WorkflowGraphContract,
} from '@pertexo/contracts';
import { describe, expect, it } from 'vitest';
import { workflowConnectionIssues } from '@/features/workflow-editor/model/connection-issues';
import { workflowIssuesView } from '@/features/workflow-publish/model/validation/issues-state';
import { emptyLoopStructure } from '@/features/workflow-editor/model/graph/scopes';
import { slackConnection } from '../../support/fixtures/slack-channels';
import {
  compatibility,
  setDefinition,
  workspaceId,
} from '../../support/fixtures/workflow-editor';

const connectionId = '44444444-4444-4444-8444-444444444444';
const slack = connectionResponseSchema.parse(
  slackConnection(workspaceId, connectionId),
);
const definition = {
  ...setDefinition,
  definition: { key: 'slack.send_message', version: 1 },
  connectionRequirements: ['slack_bot_token'],
};
type Node = WorkflowGraphContract['nodes'][number];
function node(id: string, extra: Partial<Node> = {}): Node {
  return {
    id,
    definition: definition.definition,
    configVersion: 1,
    config: {},
    inputMappings: {},
    connectionRefs: {},
    position: { x: 0, y: 0 },
    ...extra,
  };
}
function graph(nodes: readonly Node[]): WorkflowGraphContract {
  return { nodes, edges: [], settings: {} };
}
const linked = graph([
  node('post', { connectionRefs: { slack_bot_token: connectionId } }),
]);
const draft = { generation: 0, revision: 1 };
const report = {
  valid: true,
  currentPublication: null,
  issues: [],
  compatibility,
};
const validation = { report, etag: 'same', requestedEtag: 'same', ...draft };
const publication = {
  validation,
  validationPending: false,
  validationError: undefined,
};

describe('editor credential issues', () => {
  it('lets an optional connection stay empty but still flags a removed one', () => {
    const http = {
      ...definition,
      definition: { key: 'http.request', version: 1 },
      connectionRequirements: ['http_headers'],
      optionalConnections: ['http_headers'],
    };
    const request = (connectionRefs: Node['connectionRefs']) =>
      graph([node('call', { definition: http.definition, connectionRefs })]);
    expect(
      workflowConnectionIssues({
        graph: request({}),
        definitions: [http],
        connections: [],
        available: true,
      }),
    ).toEqual([]);
    expect(
      workflowConnectionIssues({
        graph: request({
          http_headers: '55555555-5555-4555-8555-555555555555',
        }),
        definitions: [http],
        connections: [],
        available: true,
      }),
    ).toHaveLength(1);
  });

  it('counts a missing selection before the first server check and targets Setup', () => {
    const current = graph([node('post')]);
    const issues = workflowConnectionIssues({
      graph: current,
      definitions: [definition],
      connections: [],
      available: true,
    });
    expect(issues).toMatchObject([
      {
        message: 'Choose a Slack connection for this step.',
        target: { nodeId: 'post' },
      },
    ]);
    const view = workflowIssuesView(
      { ...publication, validation: undefined },
      current,
      draft,
      issues,
    );
    expect(view.groups?.[0]?.issues).toHaveLength(1);
    expect(view.countsByNode.get('post')).toBe(1);
    expect(view.blockingGroups).toEqual([]);
    expect(
      workflowIssuesView(
        { ...publication, validation: undefined },
        linked,
        draft,
      ).groups,
    ).toBeUndefined();
  });

  it.each(['revoked', 'reauthorization_required'] as const)(
    'counts the selected %s credential',
    (status) => {
      const issues = workflowConnectionIssues({
        graph: linked,
        definitions: [definition],
        connections: [{ ...slack, status }],
        available: true,
      });
      expect(issues).toHaveLength(1);
      expect(issues[0]?.message).toContain(
        status === 'revoked' ? 'was revoked' : 'needs reauthorizing',
      );
    },
  );

  it('counts a missing or mismatched credential without treating unknown health as rejection', () => {
    expect(
      workflowConnectionIssues({
        graph: linked,
        definitions: [definition],
        connections: [],
        available: true,
      })[0]?.message,
    ).toContain('is unavailable');
    const wrongKind = connectionResponseSchema.parse({
      ...slack,
      providerKey: 'http',
      authType: 'http_headers',
    });
    expect(
      workflowConnectionIssues({
        graph: linked,
        definitions: [definition],
        connections: [wrongKind],
        available: true,
      })[0]?.message,
    ).toContain('different credential type');
    expect(
      workflowConnectionIssues({
        graph: linked,
        definitions: [definition],
        connections: [slack],
        available: true,
      }),
    ).toEqual([]);
    expect(
      workflowConnectionIssues({
        graph: linked,
        definitions: [definition],
        connections: [
          {
            ...slack,
            health: {
              ...slack.health,
              lastTestedAt: '2026-10-11T10:00:00.000Z',
              lastErrorCode: 'connection.test.dns_failed',
            },
          },
        ],
        available: true,
      }),
    ).toEqual([]);
  });

  it('explains server unavailability instead of guessing that a credential was revoked', () => {
    expect(
      workflowConnectionIssues({
        graph: linked,
        definitions: [definition],
        connections: [],
        available: false,
      })[0]?.message,
    ).toContain('Connections are unavailable here');
  });

  it('checks enabled nested bodies and skips disabled steps and their bodies', () => {
    const structure = emptyLoopStructure();
    const loop = node('loop', {
      definition: { key: 'core.foreach', version: 1 },
      structured: {
        ...structure,
        body: { ...structure.body, nodes: [node('nested')] },
      },
    });
    const current = graph([
      loop,
      node('off', { disabled: true }),
      { ...loop, id: 'off-loop', disabled: true },
    ]);
    expect(
      workflowConnectionIssues({
        graph: current,
        definitions: [definition],
        connections: [],
        available: true,
      }).map((issue) => issue.target?.nodeId),
    ).toEqual(['nested']);
  });

  it('groups server and credential findings once while preserving server publication rules', () => {
    const current = graph([node('post')]);
    const findings = workflowConnectionIssues({
      graph: current,
      definitions: [definition],
      connections: [],
      available: true,
    });
    const checked = {
      ...publication,
      validation: {
        ...validation,
        report: {
          ...report,
          valid: false,
          currentPublication: null,
          issues: [
            {
              path: '$.nodes[0].config.count',
              code: 'invalid_config',
              message: 'Count is required',
            },
          ],
        },
      },
    };
    const view = workflowIssuesView(checked, current, draft, findings);
    expect(view.groups).toHaveLength(1);
    expect(view.groups?.[0]?.issues).toHaveLength(2);
    expect(view.countsByNode.get('post')).toBe(2);
    expect(view.blockingGroups[0]?.issues).toHaveLength(1);
    expect(
      workflowIssuesView(checked, current, { ...draft, revision: 2 }, findings),
    ).toMatchObject({ stale: true, blockingGroups: [] });
    expect(workflowIssuesView(publication, linked, draft)).toMatchObject({
      groups: [],
      blockingGroups: [],
    });
  });
});
