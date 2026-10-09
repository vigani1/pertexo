import {
  createWorkflowInputCaseTag,
  parseWorkflowInputCaseTag,
  workflowInputCaseCreateRequestSchema,
  workflowInputCaseUpdateRequestSchema,
  workflowInputCaseCommandResponseSchema,
  workflowInputCaseListResponseSchema,
  workflowInputCaseResponseSchema,
  workflowInputCaseQuerySchema,
} from '@pertexo/contracts/workflow-authoring';
import type {
  WorkflowInputCaseDatabase,
  WorkflowInputCaseMetadata,
} from '@pertexo/database/authoring';
import {
  authorizeWorkspaceOperation,
  type WorkspaceAuthorizationSource,
} from '../workspaces/index.js';
import { applicationError } from '../platform/http/index.js';
import type { WorkflowApplicationInput } from './ports.js';
import { WorkflowHeaderError } from './preconditions.js';
import {
  decodeInputCaseCursor,
  encodeInputCaseCursor,
} from './input-case-cursor.js';

type ReadInput = WorkflowApplicationInput &
  Readonly<{ workflowId: string; signal?: AbortSignal }>;
type CaseInput = ReadInput & Readonly<{ caseId: string }>;
type CommandInput = ReadInput &
  Readonly<{ request: unknown; idempotencyKey: string }>;
type CaseCommandInput = CaseInput &
  Readonly<{ idempotencyKey: string; representationTag: string }>;

/** Durable case commands remain independent of manual run admission and loaded JSON. */
export class WorkflowInputCasesUseCase {
  public constructor(
    private readonly persistence: WorkflowInputCaseDatabase,
    private readonly authorization: WorkspaceAuthorizationSource,
  ) {}
  public async list(input: ReadInput & Readonly<{ query: unknown }>) {
    await this.authorize(input, 'workflow:read');
    const query = workflowInputCaseQuerySchema.parse(input.query);
    const context = this.context(input);
    const result = await this.persistence.listCases({
      ...context,
      limit: query.limit,
      ...(query.after === undefined
        ? {}
        : { cursor: decodeInputCaseCursor(query.after, context) }),
    });
    return workflowInputCaseListResponseSchema.parse({
      items: result.items.map(metadata),
      ...(result.nextCursor === undefined
        ? {}
        : { nextCursor: encodeInputCaseCursor(context, result.nextCursor) }),
    });
  }
  public async get(input: CaseInput) {
    await this.authorize(input, 'workflow:read');
    const result = await this.persistence.getCase({
      ...this.context(input),
      caseId: input.caseId,
    });
    return workflowInputCaseResponseSchema.parse({
      case: { ...metadata(result.case), input: result.case.input },
    });
  }
  public async create(input: CommandInput) {
    await this.authorize(input, 'workflow:update');
    const request = workflowInputCaseCreateRequestSchema.parse(input.request);
    return workflowInputCaseCommandResponseSchema.parse(
      await this.persistence.createCase({
        ...this.commandContext(input),
        ...request,
      }),
    );
  }
  public async update(
    input: CaseCommandInput & Readonly<{ request: unknown }>,
  ) {
    await this.authorize(input, 'workflow:update');
    const expectedRevision = expectedCaseRevision(
      input.representationTag,
      input.caseId,
    );
    const request = workflowInputCaseUpdateRequestSchema.parse(input.request);
    return workflowInputCaseCommandResponseSchema.parse(
      await this.persistence.updateCase({
        ...this.commandContext(input),
        caseId: input.caseId,
        expectedRevision,
        ...request,
      }),
    );
  }
  public async delete(input: CaseCommandInput) {
    await this.authorize(input, 'workflow:update');
    const expectedRevision = expectedCaseRevision(
      input.representationTag,
      input.caseId,
    );
    return workflowInputCaseCommandResponseSchema.parse(
      await this.persistence.deleteCase({
        ...this.commandContext(input),
        caseId: input.caseId,
        expectedRevision,
      }),
    );
  }
  private context(input: ReadInput) {
    input.signal?.throwIfAborted();
    return {
      workspaceId: input.routeWorkspaceId,
      workflowId: input.workflowId,
      actorId: input.actor.actorId,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    };
  }
  private commandContext(
    input: ReadInput & Readonly<{ idempotencyKey: string }>,
  ) {
    return {
      ...this.context(input),
      idempotencyKey: input.idempotencyKey,
      requestId: input.actor.requestId,
      ...(input.actor.traceId === undefined
        ? {}
        : { traceId: input.actor.traceId }),
    };
  }
  private async authorize(
    input: ReadInput,
    capability: 'workflow:read' | 'workflow:update',
  ) {
    input.signal?.throwIfAborted();
    await authorizeWorkspaceOperation({
      actor: input.actor,
      routeWorkspaceId: input.routeWorkspaceId,
      capability,
      access: this.authorization,
      disclosure: 'not_found',
      allowedWorkspaceStatuses: ['active'],
      ...(input.signal === undefined ? {} : { signal: input.signal }),
      ...(input.authorizedWorkspace === undefined
        ? {}
        : { authorizedWorkspace: input.authorizedWorkspace }),
    });
    input.signal?.throwIfAborted();
  }
}
function metadata(item: WorkflowInputCaseMetadata) {
  return {
    id: item.id,
    workspaceId: item.workspaceId,
    workflowId: item.workflowId,
    workflowVersionId: item.workflowVersionId,
    versionChecksum: item.versionChecksum,
    name: item.name,
    revision: item.revision,
    representationTag: createWorkflowInputCaseTag(item.id, item.revision),
    createdAt: item.createdAt.toISOString(),
    updatedAt: item.updatedAt.toISOString(),
  };
}
function expectedCaseRevision(tag: string, caseId: string): number {
  const parsed = parseWorkflowInputCaseTag(tag);
  if (parsed === undefined)
    throw new WorkflowHeaderError('invalid', 'If-Match');
  if (parsed.caseId !== caseId.toLowerCase()) {
    // A validator for another representation is a failed precondition, not authority.
    // eslint-disable-next-line @typescript-eslint/only-throw-error
    throw applicationError('workflow.input_case_revision_conflict', {
      safeDetail:
        'The case representation has changed; reload it before confirming a new command.',
    });
  }
  return parsed.revision;
}
