import type { ApiProblemCode } from '../errors/api-problem.js';
import { catalogOpenApiDocument } from './catalog.js';
import { connectionsOpenApiDocument } from './connections.js';
import { artifactTransferOpenApiDocument } from './execution/artifact-transfer.js';
import { nodeTestingOpenApiDocument } from './execution/node-testing.js';
import { workflowRunsOpenApiDocument } from './execution/runs.js';
import { workspaceInboxOpenApiDocument } from './identity/inbox.js';
import { identityWorkspaceOpenApiDocument } from './identity/workspaces.js';
import { schedulesOpenApiDocument } from './triggers/schedules.js';
import { webhooksOpenApiDocument } from './triggers/webhooks.js';
import { workflowAuthoringOpenApiDocument } from './workflows/authoring.js';
import { workflowPortabilityOpenApiDocument } from './workflows/portability.js';

type PublicOperation = Readonly<{
  summary: string;
  tag: 'Tokens' | 'Workflows' | 'Connections' | 'Runs';
  scopes: readonly string[];
  /** Beyond what every token route can answer. */
  problems?: readonly ApiProblemCode[];
}>;

type JsonObject = Record<string, unknown>;
type Operation = JsonObject &
  Readonly<{
    operationId?: string;
    security?: readonly JsonObject[];
    parameters?: readonly JsonObject[];
  }>;
type Document = Readonly<{
  paths: Readonly<Record<string, Readonly<Record<string, Operation>>>>;
  components?: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
}>;

/** A route that takes a token is public: it's documented here, or the build fails. */
const PUBLIC_OPERATIONS: Readonly<Record<string, PublicOperation>> = {
  readCurrentApiToken: {
    summary: 'Read the calling token',
    tag: 'Tokens',
    scopes: [],
  },
  listWorkflows: {
    summary: 'List workflows',
    tag: 'Workflows',
    scopes: ['workflow:read'],
  },
  getWorkflow: {
    summary: 'Read a workflow',
    tag: 'Workflows',
    scopes: ['workflow:read'],
  },
  createWorkflow: {
    summary: 'Create a blank workflow',
    tag: 'Workflows',
    scopes: ['workflow:create'],
    problems: ['request.idempotency_conflict', 'workflow.name_conflict'],
  },
  saveWorkflowDraft: {
    summary: 'Save a workflow draft',
    tag: 'Workflows',
    scopes: ['workflow:update'],
    problems: [
      'request.precondition_required',
      'workflow.revision_conflict',
      'workflow.invalid',
    ],
  },
  getWorkflowDraft: {
    summary: 'Read a workflow draft',
    tag: 'Workflows',
    scopes: ['workflow:read'],
  },
  listWorkflowVersions: {
    summary: 'List published versions',
    tag: 'Workflows',
    scopes: ['workflow:read'],
  },
  publishWorkflow: {
    summary: 'Publish a draft',
    tag: 'Workflows',
    scopes: ['workflow:publish'],
    problems: [
      'request.precondition_required',
      'request.idempotency_conflict',
      'workflow.revision_conflict',
      'workflow.invalid',
      'workflow.publish_approval_required',
      'workflow.validation_unavailable',
    ],
  },
  exportWorkflow: {
    summary: 'Export a workflow',
    tag: 'Workflows',
    scopes: ['workflow:read'],
    problems: [
      'request.precondition_required',
      'workflow.revision_conflict',
      'workflow.portability_review_conflict',
      'workflow.portability_unavailable',
    ],
  },
  previewWorkflowImport: {
    summary: 'Preview an import',
    tag: 'Workflows',
    scopes: ['workflow:create', 'connection:read'],
    problems: [
      'workflow.portability_invalid',
      'workflow.portability_compatibility_conflict',
      'workflow.portability_unavailable',
    ],
  },
  importWorkflow: {
    summary: 'Import a workflow',
    tag: 'Workflows',
    scopes: ['workflow:create', 'connection:read'],
    problems: [
      'request.idempotency_conflict',
      'workflow.portability_invalid',
      'workflow.portability_review_conflict',
      'workflow.portability_compatibility_conflict',
      'workflow.portability_unavailable',
    ],
  },
  archiveWorkflow: {
    summary: 'Archive a workflow',
    tag: 'Workflows',
    scopes: ['workflow:publish'],
    problems: ['request.idempotency_conflict', 'workflow.lifecycle_conflict'],
  },
  restoreWorkflow: {
    summary: 'Restore an archived workflow',
    tag: 'Workflows',
    scopes: ['workflow:publish'],
    problems: ['request.idempotency_conflict', 'workflow.lifecycle_conflict'],
  },
  getWorkflowAutoPauseSettings: {
    summary: 'Read automatic-pause settings',
    tag: 'Workflows',
    scopes: ['workflow:read'],
  },
  updateWorkflowAutoPauseSettings: {
    summary: 'Update automatic-pause settings',
    tag: 'Workflows',
    scopes: ['workflow:update'],
    problems: [
      'request.idempotency_conflict',
      'workflow.auto_pause_settings_conflict',
    ],
  },
  resumeWorkflow: {
    summary: 'Resume automatic triggers',
    tag: 'Workflows',
    scopes: ['workflow:publish'],
    problems: ['request.idempotency_conflict', 'workflow.pause_conflict'],
  },
  listConnections: {
    summary: 'List connections',
    tag: 'Connections',
    scopes: ['connection:read'],
  },
  getConnection: {
    summary: 'Read a connection',
    tag: 'Connections',
    scopes: ['connection:read'],
  },
  startWorkflowRun: {
    summary: 'Start a run',
    tag: 'Runs',
    scopes: ['run:start'],
    problems: [
      'request.idempotency_conflict',
      'workflow.not_published',
      'workflow.already_running',
      'workflow.published_version_conflict',
      'workspace.quota_exceeded',
      'workspace.conflict',
      'form.required',
    ],
  },
  listWorkflowRuns: { summary: 'List runs', tag: 'Runs', scopes: ['run:read'] },
  getWorkflowRun: { summary: 'Read a run', tag: 'Runs', scopes: ['run:read'] },
  getWorkflowRunInput: {
    summary: 'Read a run’s input',
    tag: 'Runs',
    scopes: ['run:read-data'],
  },
  getWorkflowNodeRunInput: {
    summary: 'Read a step’s input',
    tag: 'Runs',
    scopes: ['run:read-data'],
  },
  getWorkflowNodeRunOutput: {
    summary: 'Read a step’s output',
    tag: 'Runs',
    scopes: ['run:read-data'],
  },
  cancelWorkflowRun: {
    summary: 'Cancel a run',
    tag: 'Runs',
    scopes: ['run:cancel'],
    problems: ['run.not_cancelable'],
  },
};

const EVERY_TOKEN_ROUTE: readonly ApiProblemCode[] = [
  'request.invalid',
  'auth.unauthenticated',
  'auth.token_scope_required',
  'auth.forbidden',
  'resource.not_found',
  'request.rate_limited',
  'request.rate_limit_unavailable',
  'api_token.unavailable',
];

const DOCUMENTS = [
  catalogOpenApiDocument,
  artifactTransferOpenApiDocument,
  connectionsOpenApiDocument,
  identityWorkspaceOpenApiDocument,
  nodeTestingOpenApiDocument,
  workflowAuthoringOpenApiDocument,
  workflowRunsOpenApiDocument,
  workflowPortabilityOpenApiDocument,
  schedulesOpenApiDocument,
  webhooksOpenApiDocument,
  workspaceInboxOpenApiDocument,
] as readonly unknown[] as readonly Document[];

function takesToken({ security }: Operation): boolean {
  return security?.some((scheme) => 'apiToken' in scheme) ?? false;
}

/** A token never sends a CSRF header, so its reader doesn't need to hear about it. */
function publicOperation(operation: Operation): Operation {
  const id = operation.operationId;
  const facts = id === undefined ? undefined : PUBLIC_OPERATIONS[id];
  if (facts === undefined)
    throw new Error(
      `Token route ${String(id)} isn't in PUBLIC_OPERATIONS: give it a summary, a tag and its scopes`,
    );
  return {
    ...operation,
    summary: facts.summary,
    tags: [facts.tag],
    security: [{ apiToken: [] }],
    parameters: (operation.parameters ?? []).filter(
      ({ name }) => String(name).toLowerCase() !== 'x-csrf-token',
    ),
    'x-pertexo-api-token-scopes': facts.scopes,
    'x-pertexo-problem-codes': [
      ...EVERY_TOKEN_ROUTE,
      ...(facts.problems ?? []),
    ],
  };
}

function componentReferences(value: unknown, into: Set<string>): void {
  if (Array.isArray(value)) {
    for (const item of value) componentReferences(item, into);
    return;
  }
  if (typeof value !== 'object' || value === null) return;
  for (const [key, nested] of Object.entries(value)) {
    if (key === '$ref' && typeof nested === 'string') {
      const match = /^#\/components\/(?<kind>[^/]+)\/(?<name>[^/]+)/u.exec(
        nested,
      );
      if (match?.groups !== undefined)
        into.add(`${match.groups.kind ?? ''}/${match.groups.name ?? ''}`);
    } else componentReferences(nested, into);
  }
}

function decoded(name: string): string {
  return name.replaceAll('~1', '/').replaceAll('~0', '~');
}

/** Only what the public operations reach, however deep. */
function reachableComponents(
  paths: JsonObject,
  owner: ReadonlyMap<string, unknown>,
): Record<string, Record<string, unknown>> {
  const seen = new Set<string>();
  const pending = new Set<string>();
  componentReferences(paths, pending);
  const components: Record<string, Record<string, unknown>> = {};
  for (const reference of pending) {
    if (seen.has(reference)) continue;
    seen.add(reference);
    const [kind = '', name = ''] = reference.split('/');
    const component = owner.get(reference);
    if (component === undefined)
      throw new Error(`Public spec can't resolve ${reference}`);
    (components[kind] ??= {})[decoded(name)] = component;
    // A Set iterates what's added during the loop, which walks the whole closure.
    componentReferences(component, pending);
  }
  return components;
}

function buildPublicDocument() {
  const paths: Record<string, Record<string, Operation>> = {};
  const owner = new Map<string, unknown>();
  for (const { paths: documented, components } of DOCUMENTS) {
    for (const [path, methods] of Object.entries(documented))
      for (const [method, operation] of Object.entries(methods))
        if (takesToken(operation))
          (paths[path] ??= {})[method] = publicOperation(operation);
    for (const [kind, entries] of Object.entries(components ?? {}))
      for (const [name, component] of Object.entries(entries))
        if (!owner.has(`${kind}/${name}`))
          owner.set(`${kind}/${name}`, component);
  }
  const { securitySchemes: _unused, ...components } = reachableComponents(
    paths,
    owner,
  );
  return {
    openapi: '3.1.0',
    info: {
      title: 'Pertexo API',
      version: '1',
      license: {
        name: 'PolyForm Noncommercial 1.0.0',
        identifier: 'PolyForm-Noncommercial-1.0.0',
      },
      description:
        'The routes that accept an API token. Adding fields, statuses or problem codes is always allowed, so ignore what you don’t know. Breaking changes go to a new version with notice. See docs/guides/api-conventions.md.',
    },
    servers: [{ url: '/' }],
    tags: [
      { name: 'Tokens', description: 'The credential a script calls with' },
      {
        name: 'Workflows',
        description: 'Read, export, import and publish workflows',
      },
      {
        name: 'Connections',
        description: 'Read connections; secrets never leave the server',
      },
      { name: 'Runs', description: 'Start, read and cancel runs' },
    ],
    paths,
    components: {
      ...components,
      securitySchemes: {
        apiToken: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'ptx_1 opaque personal token',
        },
      },
    },
  };
}

/** Served by the API, and committed so a change to the public surface shows in review. */
export const publicOpenApiDocument = Object.freeze(buildPublicDocument());
