import type { ControlNodeConfig } from '@pertexo/workflow-model';
import type { ExecutionFailureRoute } from '../../compilation/workflow-executable.js';

import type {
  BranchScopePart,
  IterationScopePart,
} from '../../workflow-execution.js';
import type { SideEffectClass } from '../../workflow-execution.js';

/** Private execution projection derived only from a verified executable. */
export interface SchedulerState {
  readonly failureRoutes?: readonly ExecutionFailureRoute[];
  readonly deriveReadiness: boolean;
  readonly nodes: readonly {
    readonly id: string;
    readonly definition?: { readonly key: string; readonly version: number };
    readonly config?: Readonly<Record<string, unknown>>;
    readonly control?: ControlNodeConfig;
    readonly disabled?: boolean;
    readonly sideEffectClass: SideEffectClass;
    /** Set when this step's config makes each attempt read-only (an HTTP GET). */
    readonly readOnlyAttempts?: boolean;
  }[];
  readonly edges: readonly {
    readonly source: { readonly nodeId: string; readonly port: string };
    readonly target: { readonly nodeId: string; readonly port: string };
  }[];
  readonly structuredBodies?: readonly {
    readonly loopNodeId: string;
    readonly nodes: SchedulerState['nodes'];
    readonly edges: SchedulerState['edges'];
  }[];
}

export interface ReadyNodeDecision {
  readonly invocationKey: string;
  readonly nodeId: string;
  readonly disposition: 'ready' | 'skipped';
  readonly branchPath?: readonly BranchScopePart[];
  readonly iterationPath?: readonly IterationScopePart[];
}
