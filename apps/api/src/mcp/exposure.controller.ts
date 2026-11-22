import { Controller, Inject } from '@nestjs/common';
import type { WorkflowAuthoringStore } from '@pertexo/core/authoring';
import { McpExposureConflictError } from '@pertexo/core/authoring';
import {
  workflowSettingsRoutes as routes,
  type RouteInput,
} from '@pertexo/contracts/server';
import { In, Route } from '../platform/http/route.js';
import {
  applicationError,
  throwApplicationError,
} from '../platform/http/index.js';
import {
  Caller,
  requestIdentifiers,
  storeCaller,
  type WorkspaceCaller,
} from '../workspaces/request/caller.js';

export const MCP_EXPOSURE = Symbol('MCP_EXPOSURE');

@Controller()
export class McpExposureController {
  public constructor(
    @Inject(MCP_EXPOSURE) private readonly store: WorkflowAuthoringStore['mcp'],
  ) {}

  @Route(routes.mcp)
  public async read(
    @Caller() caller: WorkspaceCaller,
    @In() { params }: RouteInput<typeof routes.mcp>,
  ) {
    return this.store.read({
      ...storeCaller(caller),
      workflowId: params.workflowId,
    });
  }

  @Route(routes.updateMcp)
  public async update(
    @Caller() caller: WorkspaceCaller,
    @In() { params, body }: RouteInput<typeof routes.updateMcp>,
  ) {
    try {
      return await this.store.update({
        ...storeCaller(caller),
        ...requestIdentifiers(caller),
        workflowId: params.workflowId,
        request: body,
      });
    } catch (error) {
      if (!(error instanceof McpExposureConflictError)) throw error;
      const safeDetails = {
        entry_unavailable:
          'Publish a workflow with a typed object input before exposing it.',
        name_in_use: 'Another published workflow uses this tool name.',
        version_changed:
          'The published workflow or its exposure changed. Refresh and review it again.',
      };
      return throwApplicationError(
        applicationError('workspace.conflict', {
          safeDetail: safeDetails[error.reason],
        }),
      );
    }
  }
}
