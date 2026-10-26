export const RATE_LIMIT_ENDPOINT_CLASSES = [
  'webhook_preflight',
  'callback_ingress',
  'notice_unsubscribe',
  'form_read',
  'form_submission',
  'form_workspace_submission',
  'form_upload',
  'identity_start',
  'automation_authentication',
  'directory_provisioning',
  'identity_callback',
  'authenticated_read',
  'data_table_export',
  'actor_mutation',
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
  | 'client_address'
  | 'origin'
  | 'actor'
  | 'workspace'
  | 'connection'
  | 'token'
  | 'form';

export type RateLimitSubject = Readonly<{
  clientAddress?: string;
  origin?: string;
  actorId?: string;
  workspaceId?: string;
  connectionId?: string;
  tokenId?: string;
  formId?: string;
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
  optional?: true;
}>;

type EndpointRule = Readonly<{
  failureMode: RateLimitFailureMode;
  dimensions: readonly DimensionRule[];
}>;

const RULES: Readonly<Record<RateLimitEndpointClass, EndpointRule>> = {
  callback_ingress: {
    failureMode: 'closed',
    dimensions: [
      { kind: 'client_address', subject: 'clientAddress', limit: 60 },
      { kind: 'token', subject: 'tokenId', limit: 60 },
    ],
  },
  webhook_preflight: {
    failureMode: 'closed',
    dimensions: [
      { kind: 'client_address', subject: 'clientAddress', limit: 60 },
    ],
  },
  notice_unsubscribe: {
    failureMode: 'closed',
    dimensions: [
      { kind: 'client_address', subject: 'clientAddress', limit: 30 },
    ],
  },
  form_read: {
    failureMode: 'closed',
    dimensions: [
      { kind: 'client_address', subject: 'clientAddress', limit: 60 },
      { kind: 'form', subject: 'formId', limit: 300 },
    ],
  },
  form_submission: {
    failureMode: 'closed',
    dimensions: [
      { kind: 'client_address', subject: 'clientAddress', limit: 10 },
      { kind: 'form', subject: 'formId', limit: 30 },
    ],
  },
  form_workspace_submission: {
    failureMode: 'closed',
    dimensions: [{ kind: 'workspace', subject: 'workspaceId', limit: 60 }],
  },
  // Begin and finalize per file: five files take ten requests.
  form_upload: {
    failureMode: 'closed',
    dimensions: [
      { kind: 'client_address', subject: 'clientAddress', limit: 20 },
      { kind: 'form', subject: 'formId', limit: 60 },
      { kind: 'workspace', subject: 'workspaceId', limit: 120 },
    ],
  },

  directory_provisioning: {
    failureMode: 'closed',
    dimensions: [{ kind: 'workspace', subject: 'workspaceId', limit: 300 }],
  },
  automation_authentication: {
    failureMode: 'closed',
    dimensions: [
      { kind: 'client_address', subject: 'clientAddress', limit: 600 },
    ],
  },
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
  data_table_export: {
    failureMode: 'closed',
    dimensions: [
      { kind: 'actor', subject: 'actorId', limit: 5 },
      { kind: 'workspace', subject: 'workspaceId', limit: 10 },
    ],
  },
  authenticated_read: {
    failureMode: 'open',
    dimensions: [
      { kind: 'actor', subject: 'actorId', limit: 600 },
      {
        kind: 'workspace',
        subject: 'workspaceId',
        limit: 1_200,
        optional: true,
      },
    ],
  },
  actor_mutation: {
    failureMode: 'closed',
    dimensions: [{ kind: 'actor', subject: 'actorId', limit: 120 }],
  },
  ordinary_mutation: {
    failureMode: 'closed',
    dimensions: [
      { kind: 'actor', subject: 'actorId', limit: 120 },
      {
        kind: 'workspace',
        subject: 'workspaceId',
        limit: 300,
        optional: true,
      },
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
      {
        kind: 'connection',
        subject: 'connectionId',
        limit: 10,
        optional: true,
      },
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
  tokenId: 'token',
  formId: 'form',
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
    const dimensions: RateLimitDimension[] = rule.dimensions.flatMap(
      ({ kind, subject: key, limit, optional }) => {
        if ((optional ?? false) && subject[key] === undefined) return [];
        return [{ kind, identifier: requiredSubject(subject, key), limit }];
      },
    );
    const actorBudget = dimensions.find(
      (dimension) => dimension.kind === 'actor',
    );
    if (subject.tokenId !== undefined && actorBudget !== undefined)
      dimensions.push({
        kind: 'token',
        identifier: requiredSubject(subject, 'tokenId'),
        limit: actorBudget.limit,
      });
    return {
      endpointClass,
      failureMode: rule.failureMode,
      windowSeconds: 60,
      dimensions,
    };
  }
}
