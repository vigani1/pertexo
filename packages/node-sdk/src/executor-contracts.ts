import type { ZodType } from 'zod';

import type {
  DefinitionIdentity,
  ExecutorIdentity,
  NodeManifest,
  NodeCatalog,
} from './catalog.js';
export type JsonValue =
  null | boolean | number | string | readonly JsonValue[] | JsonObject;

// A recursive JSON contract cannot be expressed through a finite Record alias.
interface JsonObject {
  readonly [key: string]: JsonValue;
}

export interface NodeExecutionInvocation<Config, Input> {
  readonly config: Config;
  readonly input: Input;
  readonly connectionRefs: Readonly<Record<string, string>>;
  readonly signal: AbortSignal;
  readonly runtime?: NodeExecutionRuntime;
}

export type NodeSideEffectClass = 'safe' | 'idempotent_with_key' | 'unsafe';

/** Provider-owned evidence only; dispatch persistence determines its target. */
export type NodeConnectionHealthObservation =
  | Readonly<{ kind: 'healthy' }>
  | Readonly<{
      kind: 'reauthorization_required';
      reasonCode:
        | 'connection.slack_account_inactive'
        | 'connection.slack_token_expired'
        | 'connection.slack_token_revoked';
    }>;

export type ResolvedNodeConnection = Readonly<{
  connectionId: string;
  providerKey: string;
  authType: string;
  secretVersionId: string;
  secret: Uint8Array;
}>;

export interface NodeConnectionRuntime {
  resolve(
    input: Readonly<{
      connectionId: string;
      expectedProviderKey: string;
      expectedAuthType: string;
      purpose: string;
      signal: AbortSignal;
    }>,
  ): Promise<ResolvedNodeConnection>;
  readonly assertCurrent?: (
    input: Readonly<{
      connectionId: string;
      expectedProviderKey: string;
      expectedAuthType: string;
      secretVersionId: string;
      signal: AbortSignal;
    }>,
  ) => Promise<void>;
}

export type NodeArtifactReference = Readonly<{
  artifactId: string;
  byteLength: number;
  mediaType: string;
  sha256: string;
}>;

export interface NodeArtifactRuntime {
  write(
    input: Readonly<{
      body: AsyncIterable<Uint8Array>;
      maxBytes: number;
      mediaType: string;
      purpose: string;
      signal: AbortSignal;
    }>,
  ): Promise<NodeArtifactReference>;
}

export interface NodeExecutionRuntime {
  readonly workspaceId: string;
  readonly runId: string;
  readonly nodeRunId: string;
  readonly attemptId: string;
  readonly attemptNumber: number;
  readonly nodeId: string;
  readonly invocationKey: string;
  readonly sideEffectClass: NodeSideEffectClass;
  readonly providerIdempotencyKey?: string;
  readonly providerDispatchBinding?: string;
  readonly providerDispatchUnresolved?: true;
  readonly connections?: NodeConnectionRuntime;
  readonly artifacts?: NodeArtifactRuntime;
  /** Synchronous, nonthrowing capture only. Never performs persistence or I/O. */
  readonly observeConnectionHealth?: (
    observation: NodeConnectionHealthObservation,
  ) => void;
  beforeDispatch(
    input?: Readonly<{
      connectionFence?: Readonly<{
        connectionId: string;
        expectedProviderKey: string;
        expectedAuthType: string;
        secretVersionId: string;
      }>;
      providerDispatchBinding?: string;
    }>,
  ): Promise<void>;
}

/** The implementation of a catalog executor; the catalog owns its metadata. */
export interface NodeExecutorRegistration {
  readonly executor: ExecutorIdentity;
  readonly execute: (
    invocation: NodeExecutionInvocation<unknown, unknown>,
  ) => Promise<unknown>;
}

export interface NodeDefinitionRegistration {
  readonly manifest: NodeManifest;
  readonly configSchema: ZodType;
  readonly inputSchema: ZodType;
  readonly outputSchema: ZodType;
}

export interface NodeRegistryOptions {
  readonly catalog: NodeCatalog;
  readonly definitions: readonly NodeDefinitionRegistration[];
  readonly executors: readonly NodeExecutorRegistration[];
}

export interface NodeExecutionRequest {
  readonly definition: DefinitionIdentity;
  readonly executor: ExecutorIdentity;
  readonly config: unknown;
  readonly input: unknown;
  readonly connectionRefs?: Readonly<Record<string, string>>;
  readonly signal: AbortSignal;
  readonly runtime?: NodeExecutionRuntime;
}

export type NodeExecutionKind = 'succeeded' | 'terminal_success';

export interface NodeExecutionResult {
  readonly kind: NodeExecutionKind;
  readonly output: JsonValue;
}
