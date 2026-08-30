export const RATE_LIMIT_ENDPOINT_CLASSES = [
  'identity_start',
  'identity_callback',
  'authenticated_read',
  'ordinary_mutation',
  'workflow_compile',
  'run_admission',
  'preview_test',
  'connection_mutation',
  'provider_test',
  'trigger_mutation',
  'provider_execution',
] as const;

export type RateLimitEndpointClass =
  (typeof RATE_LIMIT_ENDPOINT_CLASSES)[number];
export type RateLimitFailureMode = 'open' | 'closed';
export type RateLimitDimensionKind =
  'client_address' | 'origin' | 'actor' | 'workspace' | 'connection';

export type RateLimitSubject = Readonly<{
  clientAddress?: string;
  origin?: string;
  actorId?: string;
  workspaceId?: string;
  connectionId?: string;
}>;

export type RateLimitDimension = Readonly<{
  kind: RateLimitDimensionKind;
  identifier: string;
  limit: number;
}>;

export type RateLimitDecision = Readonly<{
  endpointClass: RateLimitEndpointClass;
  failureMode: RateLimitFailureMode;
  windowSeconds: number;
  dimensions: readonly RateLimitDimension[];
}>;

type DimensionRule = Readonly<{
  kind: RateLimitDimensionKind;
  subject: keyof RateLimitSubject;
  limit: number;
}>;

type EndpointRule = Readonly<{
  failureMode: RateLimitFailureMode;
  dimensions: readonly DimensionRule[];
}>;

const RULES: Readonly<Record<RateLimitEndpointClass, EndpointRule>> = {
  identity_start: {
    failureMode: 'closed',
    dimensions: [
      { kind: 'client_address', subject: 'clientAddress', limit: 10 },
      { kind: 'origin', subject: 'origin', limit: 30 },
    ],
  },
  identity_callback: {
    failureMode: 'closed',
    dimensions: [
      { kind: 'client_address', subject: 'clientAddress', limit: 30 },
      { kind: 'origin', subject: 'origin', limit: 60 },
    ],
  },
  authenticated_read: {
    failureMode: 'open',
    dimensions: [
      { kind: 'actor', subject: 'actorId', limit: 600 },
      { kind: 'workspace', subject: 'workspaceId', limit: 1_200 },
    ],
  },
  ordinary_mutation: {
    failureMode: 'closed',
    dimensions: [
      { kind: 'actor', subject: 'actorId', limit: 120 },
      { kind: 'workspace', subject: 'workspaceId', limit: 300 },
    ],
  },
  workflow_compile: {
    failureMode: 'closed',
    dimensions: [
      { kind: 'actor', subject: 'actorId', limit: 30 },
      { kind: 'workspace', subject: 'workspaceId', limit: 60 },
    ],
  },
  run_admission: {
    failureMode: 'closed',
    dimensions: [
      { kind: 'actor', subject: 'actorId', limit: 60 },
      { kind: 'workspace', subject: 'workspaceId', limit: 120 },
    ],
  },
  preview_test: {
    failureMode: 'closed',
    dimensions: [
      { kind: 'actor', subject: 'actorId', limit: 20 },
      { kind: 'workspace', subject: 'workspaceId', limit: 40 },
    ],
  },
  connection_mutation: {
    failureMode: 'closed',
    dimensions: [
      { kind: 'actor', subject: 'actorId', limit: 30 },
      { kind: 'workspace', subject: 'workspaceId', limit: 60 },
      { kind: 'connection', subject: 'connectionId', limit: 10 },
    ],
  },
  provider_test: {
    failureMode: 'closed',
    dimensions: [
      { kind: 'actor', subject: 'actorId', limit: 10 },
      { kind: 'workspace', subject: 'workspaceId', limit: 20 },
      { kind: 'connection', subject: 'connectionId', limit: 5 },
    ],
  },
  trigger_mutation: {
    failureMode: 'closed',
    dimensions: [
      { kind: 'actor', subject: 'actorId', limit: 60 },
      { kind: 'workspace', subject: 'workspaceId', limit: 120 },
    ],
  },
  provider_execution: {
    failureMode: 'closed',
    dimensions: [
      { kind: 'workspace', subject: 'workspaceId', limit: 300 },
      { kind: 'connection', subject: 'connectionId', limit: 60 },
    ],
  },
};

const SUBJECT_LABELS: Readonly<Record<keyof RateLimitSubject, string>> = {
  clientAddress: 'client address',
  origin: 'origin',
  actorId: 'actor',
  workspaceId: 'workspace',
  connectionId: 'connection',
};

function requiredSubject(
  subject: RateLimitSubject,
  key: keyof RateLimitSubject,
): string {
  const value = subject[key]?.trim();
  if (value === undefined || value.length === 0) {
    throw new Error(`Rate-limit ${SUBJECT_LABELS[key]} subject is required`);
  }
  return value;
}

export class AbuseRateLimitPolicy {
  evaluate(
    endpointClass: RateLimitEndpointClass,
    subject: RateLimitSubject,
  ): RateLimitDecision {
    const rule = RULES[endpointClass];
    return {
      endpointClass,
      failureMode: rule.failureMode,
      windowSeconds: 60,
      dimensions: rule.dimensions.map(({ kind, subject: key, limit }) => ({
        kind,
        identifier: requiredSubject(subject, key),
        limit,
      })),
    };
  }
}
