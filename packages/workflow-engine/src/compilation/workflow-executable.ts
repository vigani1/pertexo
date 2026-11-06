import type {
  DefinitionIdentity,
  ExecutorIdentity,
  PolicyReference,
} from '@pertexo/node-sdk';
import type {
  ControlNodeConfig,
  WorkflowFailureRoute,
  JsonValue,
  ValueSource,
  WorkflowEdge,
  WorkflowGraph,
} from '@pertexo/workflow-model';
import type { SideEffectClass } from '../workflow-execution.js';
export interface ExecutableRuntimePolicies {
  readonly scheduler: PolicyReference;
  readonly checkpoint: PolicyReference;
  readonly retry: PolicyReference;
  readonly timeout: PolicyReference;
  readonly cancellation: PolicyReference;
}

export interface WorkflowExecutableNode {
  readonly id: string;
  readonly definition: DefinitionIdentity;
  readonly configVersion: number;
  readonly config: Readonly<Record<string, JsonValue>>;
  readonly inputMappings: Readonly<Record<string, ValueSource>>;
  readonly connectionRefs: Readonly<Record<string, string>>;
  readonly disabled: boolean;
  readonly retry?: WorkflowGraph['nodes'][number]['retry'];
  readonly sideEffectClass: SideEffectClass;
  readonly executor: ExecutorIdentity;
  readonly executorAbi: number;
  readonly policyReferences: readonly PolicyReference[];
  readonly structured?: WorkflowExecutableForEach | undefined;
}

export interface WorkflowExecutableGraph {
  readonly settings: WorkflowGraph['settings'];
  readonly callable?: WorkflowGraph['callable'];
  readonly nodes: readonly WorkflowExecutableNode[];
  readonly edges: readonly WorkflowEdge[];
}

interface WorkflowExecutableStructuredBody extends WorkflowExecutableGraph {
  readonly inputPorts: readonly string[];
  readonly outputPorts: readonly string[];
}

export interface WorkflowExecutableForEach {
  readonly kind: 'for_each';
  readonly maxIterations: number;
  readonly maxConcurrency: number;
  readonly body: WorkflowExecutableStructuredBody;
}

export interface WorkflowExecutable {
  readonly graph: WorkflowExecutableGraph;
  readonly runtimePolicies: ExecutableRuntimePolicies;
}

declare const verifiedExecutable: unique symbol;
export type VerifiedWorkflowExecutable = WorkflowExecutable & {
  readonly [verifiedExecutable]: true;
};

export interface CompiledWorkflowExecutable {
  readonly envelope: VerifiedWorkflowExecutable;
  readonly checksum: `wf:sha256:${string}`;
}
export type ExecutionFailureRoute = WorkflowFailureRoute &
  Readonly<{ normalSuffixNodeIds: readonly string[] }>;
/** A verified step with its parsed control setup; the stored executable keeps only its config. */
export type ExecutionNode = WorkflowExecutableNode &
  Readonly<{ control?: ControlNodeConfig }>;
