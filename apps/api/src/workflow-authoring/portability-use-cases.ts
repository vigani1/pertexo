import {
  workflowExportRequestSchema,
  workflowPortableManifestSchema,
  workflowImportPreviewRequestSchema,
  workflowImportPreviewResponseSchema,
  workflowImportRequestSchema,
  workflowImportResponseSchema,
} from '@pertexo/contracts/workflow-portability';
import {
  authorizeWorkspaceOperation,
  type WorkspaceAuthorizationSource,
} from '../workspaces/index.js';
import {
  applicationError,
  throwApplicationError,
} from '../platform/http/index.js';
import type {
  WorkflowApplicationInput,
  WorkflowAuthoringDependencies,
} from './ports.js';
import { parseStrongIfMatch } from './preconditions.js';
import {
  NOOP_WORKFLOW_AUTHORING_TELEMETRY,
  type WorkflowAuthoringTelemetry,
} from './telemetry.js';
import type { z } from 'zod';

type Input = WorkflowApplicationInput &
  Readonly<{ request: unknown; signal?: AbortSignal }>;
type Persistence = NonNullable<
  WorkflowAuthoringDependencies['portabilityPersistence']
>;

/** Sanitized parsing never publishes an uploaded property name or literal in Zod diagnostics. */
function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  try {
    const result = schema.safeParse(value);
    if (result.success) return result.data;
  } catch {
    // Bounded own-data preflight can refuse before Zod produces diagnostics.
  }
  return throwApplicationError(
    applicationError('request.invalid', {
      safeDetail: 'The portable workflow request is invalid.',
    }),
  );
}

class PortabilityAuthority {
  public constructor(
    protected readonly persistence: Persistence,
    private readonly authorization: WorkspaceAuthorizationSource,
    protected readonly telemetry: WorkflowAuthoringTelemetry = NOOP_WORKFLOW_AUTHORING_TELEMETRY,
  ) {}
  protected async authorize(
    input: Input,
    capability: 'workflow:read' | 'workflow:create',
    bindingCount = 0,
  ): Promise<void> {
    const authority = {
      actor: input.actor,
      routeWorkspaceId: input.routeWorkspaceId,
      access: this.authorization,
      disclosure: 'not_found' as const,
      allowedWorkspaceStatuses: ['active'] as const,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    };
    await authorizeWorkspaceOperation({
      ...authority,
      capability,
      ...(input.authorizedWorkspace?.capability === capability
        ? { authorizedWorkspace: input.authorizedWorkspace }
        : {}),
    });
    if (bindingCount > 0)
      await authorizeWorkspaceOperation({
        ...authority,
        capability: 'connection:read',
      });
  }
  protected context(input: Input) {
    return {
      workspaceId: input.routeWorkspaceId,
      actorId: input.actor.actorId,
      requestId: input.actor.requestId,
      ...(input.actor.traceId === undefined
        ? {}
        : { traceId: input.actor.traceId }),
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    };
  }
}

export class ExportWorkflowUseCase extends PortabilityAuthority {
  public execute(
    input: Input &
      Readonly<{ workflowId: string; representationTag?: unknown }>,
  ) {
    return this.telemetry.measure('workflow.export', async () => {
      await this.authorize(input, 'workflow:read');
      const command = parse(workflowExportRequestSchema, input.request);
      const representationTag =
        command.source.kind === 'draft'
          ? parseStrongIfMatch(input.representationTag)
          : undefined;
      return workflowPortableManifestSchema.parse(
        await this.persistence.exportWorkflow({
          ...this.context(input),
          workflowId: input.workflowId,
          ...command,
          ...(representationTag === undefined ? {} : { representationTag }),
        }),
      );
    });
  }
}
export class PreviewWorkflowImportUseCase extends PortabilityAuthority {
  public execute(input: Input) {
    return this.telemetry.measure('workflow.import.preview', async () => {
      const command = parse(workflowImportPreviewRequestSchema, input.request);
      await this.authorize(input, 'workflow:create', command.bindings.length);
      const { templateOrigin, ...portableCommand } = command;
      return workflowImportPreviewResponseSchema.parse(
        await this.persistence.previewWorkflowImport({
          ...this.context(input),
          ...portableCommand,
          ...(templateOrigin === undefined ? {} : { templateOrigin }),
        }),
      );
    });
  }
}
export class ImportWorkflowUseCase extends PortabilityAuthority {
  public execute(input: Input & Readonly<{ idempotencyKey: string }>) {
    return this.telemetry.measure('workflow.import', async () => {
      const command = parse(workflowImportRequestSchema, input.request);
      await this.authorize(input, 'workflow:create', command.bindings.length);
      const { templateOrigin, ...portableCommand } = command;
      return workflowImportResponseSchema.parse(
        await this.persistence.importWorkflow({
          ...this.context(input),
          ...portableCommand,
          ...(templateOrigin === undefined ? {} : { templateOrigin }),
          idempotencyKey: input.idempotencyKey,
        }),
      );
    });
  }
}
