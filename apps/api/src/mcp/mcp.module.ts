import { Module, type DynamicModule } from '@nestjs/common';
import type { WorkflowAuthoringStore } from '@pertexo/core/authoring';
import { WORKSPACE_AUTHORIZATION } from '../workspaces/tokens.js';
import type { WorkspaceAuthorizationSource } from '../authorization/index.js';
import { HttpRateLimitAdmission } from '../platform/rate-limit/admission.js';
import { McpController, McpOriginPolicy } from './mcp.controller.js';
import { McpService, type McpRuntime } from './mcp.service.js';
import { McpExposureController, MCP_EXPOSURE } from './exposure.controller.js';

@Module({})
// Nest requires a class as the dynamic module identity.
// oxlint-disable-next-line typescript/no-extraneous-class
export class McpModule {
  public static register(
    options: Readonly<{
      identity: DynamicModule;
      rateLimit: DynamicModule;
      publicOrigin: string;
      runtime: McpRuntime;
      authorization: WorkspaceAuthorizationSource;
      exposure: WorkflowAuthoringStore['mcp'];
    }>,
  ): DynamicModule {
    return {
      module: McpModule,
      imports: [options.identity, options.rateLimit],
      controllers: [McpController, McpExposureController],
      providers: [
        { provide: WORKSPACE_AUTHORIZATION, useValue: options.authorization },
        { provide: MCP_EXPOSURE, useValue: options.exposure },
        {
          provide: McpOriginPolicy,
          useValue: new McpOriginPolicy(options.publicOrigin),
        },
        {
          provide: McpService,
          inject: [HttpRateLimitAdmission],
          useFactory: (limits: HttpRateLimitAdmission) =>
            new McpService(options.runtime, limits),
        },
      ],
    };
  }
}
