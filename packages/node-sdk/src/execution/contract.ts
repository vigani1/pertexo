import type { NodeCallbackRuntime } from '../callbacks/contract.js';
import type { NodeRunValuesRuntime } from '../run-values/contract.js';
import type { NodeVerifiedByteSource } from '../artifacts/verified-source.js';
import type { NodeDataTableRuntime } from '../data-tables/contract.js';
import type { NodeCodeRuntime, CodeDiagnostics } from '../code/contract.js';
import type { NodeWebhookResponseRuntime } from './webhooks.js';
import type { NodeArtifactReference } from '../artifacts/reference.js';
export type { NodeArtifactReference } from '../artifacts/reference.js';
import type { ZodType } from 'zod';

import type {
  DefinitionIdentity,
  ExecutorIdentity,
  NodeManifest,
  NodeCatalog,
} from '../definitions/catalog.js';
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

/** What an OAuth2 connection lets a step do with its token. */
export type NodeOAuth2RequestHosts =
  | Readonly<{ mode: 'any' }>
  | Readonly<{ mode: 'listed'; hosts: readonly string[] }>;

/** An HTTP step's credential: its headers, or a token that renews by itself. */
export type ResolvedHttpCredential =
  | (ResolvedNodeConnection & Readonly<{ authType: 'http_headers' }>)
  | Readonly<{
      authType: 'oauth2';
      connectionId: string;
      providerKey: string;
      secretVersionId: string;
      accessToken: string;
      tokenVersionId: string;
      requestHosts: NodeOAuth2RequestHosts;
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
  /** An HTTP step's credential, whichever kind the connection is. */
  readonly resolveHttpCredential?: (
    input: Readonly<{
      connectionId: string;
      purpose: string;
      signal: AbortSignal;
    }>,
  ) => Promise<ResolvedHttpCredential>;
  /** After an API's 401. False when the token can't or needn't be renewed. */
  readonly rejectAccessToken?: (
    input: Readonly<{
      connectionId: string;
      tokenVersionId: string;
      signal: AbortSignal;
    }>,
  ) => Promise<boolean>;
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

export interface NodeArtifactRuntime {
  openVerified?(
    input: Readonly<{
      reference: NodeArtifactReference;
      maxBytes: number;
      signal: AbortSignal;
    }>,
  ): Promise<NodeVerifiedByteSource>;
  spool?(
    input: Readonly<{
      body: AsyncIterable<Uint8Array>;
      cancelSource?: (reason: Error) => void;
      maxBytes: number;
      signal: AbortSignal;
    }>,
  ): Promise<NodeVerifiedByteSource>;
  read?(
    input: Readonly<{
      reference: NodeArtifactReference;
      maxBytes: number;
      signal: AbortSignal;
    }>,
  ): Promise<Uint8Array>;
  write(
    input: Readonly<{
      body: AsyncIterable<Uint8Array>;
      cancelSource?: (reason: Error) => void;
      maxBytes: number;
      mediaType: string;
      purpose: string;
      signal: AbortSignal;
    }>,
  ): Promise<NodeArtifactReference>;
}

export interface NodeExecutionRuntime {
  readonly callbacks?: NodeCallbackRuntime;
  /** Existing run or preview deadline; absent for an unbounded run. */
  readonly deadlineAt?: Date;
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
  readonly webhookResponse?: NodeWebhookResponseRuntime;
  readonly dataTables?: NodeDataTableRuntime;
  readonly runValues?: NodeRunValuesRuntime;
  readonly code?: NodeCodeRuntime;
  readonly observeCodeDiagnostics?: (diagnostics: CodeDiagnostics) => void;
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
