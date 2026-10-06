import { NODE_JSON_LIMITS_V1 } from '@pertexo/node-sdk';
import {
  AUTHORING_VALIDATION_BUDGET,
  AuthoringValidationUnavailableError,
} from '@pertexo/workflow-model/authoring-validation';
import {
  callableObjectTypeDescriptorSchemaV1,
  type CallableObjectTypeDescriptorV1,
} from '@pertexo/workflow-model/callable-type-contract';
import { WORKFLOW_GRAPH_CONTRACT_LIMITS } from '@pertexo/workflow-model/graph-contract';
import {
  WORKFLOW_CALL_FAMILY_POLICY_V1,
  workflowCallPinSchemaV1,
  type WorkflowCallPinV1,
} from '@pertexo/workflow-model/workflow-call-contract';
export interface CallableTargetAssessmentRelease {
  readonly epoch: number;
  readonly fingerprint: string;
  readonly releaseJson: string;
}

export const CALLABLE_TARGET_ASSESSMENT_PURPOSE =
  'callable-target-assessment-v1';
export const CALLABLE_TARGET_ASSESSMENT_LIMITS = Object.freeze({
  uniqueVersions: WORKFLOW_CALL_FAMILY_POLICY_V1.maxChildRuns + 1,
  sourceBytes: WORKFLOW_GRAPH_CONTRACT_LIMITS.graphBytes,
  executableBytes: NODE_JSON_LIMITS_V1.bytes,
  envelopeBytes: AUTHORING_VALIDATION_BUDGET.envelopeBytes,
  members: NODE_JSON_LIMITS_V1.members,
  nodeVisits: WORKFLOW_CALL_FAMILY_POLICY_V1.maxExpandedInvocations,
  reportBytes: AUTHORING_VALIDATION_BUDGET.reportBytes,
});

/** Plain strings permit admission before stored JSON parsing or compilation. */
export interface CallableTargetAssessmentEntry {
  readonly workflowId: string;
  readonly versionId: string;
  readonly sourceJson: string;
  readonly executableJson: string;
  readonly checksum: string;
  readonly callableContractIdentity: string | null;
  readonly admissionRelease: CallableTargetAssessmentRelease;
}
export interface CallableTargetAssessmentSnapshot {
  readonly purpose: typeof CALLABLE_TARGET_ASSESSMENT_PURPOSE;
  readonly version: 1;
  readonly workspaceId: string;
  readonly currentRelease: CallableTargetAssessmentRelease;
  readonly entries: readonly CallableTargetAssessmentEntry[];
}
export interface CallableTargetAssessmentCounters {
  readonly uniqueVersions: number;
  readonly sourceBytes: number;
  readonly executableBytes: number;
  readonly envelopeBytes: number;
  readonly members: number;
  readonly nodeVisits: number;
}
export interface CallableTargetAssessmentFact {
  readonly workflowId: string;
  readonly versionId: string;
  readonly checksum: string;
  readonly pin: WorkflowCallPinV1 | null;
  readonly contract: Readonly<{
    input: CallableObjectTypeDescriptorV1;
    result: CallableObjectTypeDescriptorV1;
  }> | null;
}
export type CallableTargetAssessmentReport =
  | Readonly<{
      status: 'unavailable';
      reason: 'compatibility_support_unavailable';
    }>
  | Readonly<{ status: 'budget_exhausted' }>
  | Readonly<{
      status: 'verified';
      workspaceId: string;
      entries: readonly CallableTargetAssessmentFact[];
      counters: CallableTargetAssessmentCounters;
    }>
  | Readonly<{
      status: 'operational_failure';
      reason:
        | 'stored_data_invalid'
        | 'immutable_identity_mismatch'
        | 'unexpected_verification_failure';
    }>;

export function invalidAssessment(): never {
  throw new AuthoringValidationUnavailableError('invalid_response');
}
export function assessmentRecord(
  input: unknown,
  keys: readonly string[],
): Record<string, unknown> {
  if (input === null || typeof input !== 'object' || Array.isArray(input))
    invalidAssessment();
  const prototype: unknown = Object.getPrototypeOf(input);
  if (prototype !== Object.prototype && prototype !== null) invalidAssessment();
  const own = Reflect.ownKeys(input);
  if (own.length !== keys.length) invalidAssessment();
  const result: Record<string, unknown> = Object.create(null) as Record<
    string,
    unknown
  >;
  for (const key of keys) {
    const field = Object.getOwnPropertyDescriptor(input, key);
    if (field === undefined || !('value' in field) || !field.enumerable)
      invalidAssessment();
    result[key] = field.value;
  }
  return result;
}
function string(input: unknown): string {
  if (typeof input !== 'string') invalidAssessment();
  return input;
}
function boundedToken(input: unknown): string {
  const value = string(input);
  if (value.length > 256) invalidAssessment();
  return value;
}
function assessmentArray(input: unknown, maximum: number): unknown[] {
  if (
    !Array.isArray(input) ||
    input.length > maximum ||
    Reflect.ownKeys(input).length !== input.length + 1
  )
    invalidAssessment();
  const result: unknown[] = [];
  for (let index = 0; index < input.length; index += 1) {
    const field = Object.getOwnPropertyDescriptor(input, String(index));
    if (field === undefined || !('value' in field) || !field.enumerable)
      invalidAssessment();
    result.push(field.value);
  }
  return result;
}
const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
function identifier(input: unknown): string {
  const value = string(input);
  if (!uuid.test(value)) invalidAssessment();
  return value;
}
function release(input: unknown): CallableTargetAssessmentRelease {
  const fields = assessmentRecord(input, [
    'epoch',
    'fingerprint',
    'releaseJson',
  ]);
  if (
    typeof fields.epoch !== 'number' ||
    !Number.isSafeInteger(fields.epoch) ||
    fields.epoch < 1
  )
    invalidAssessment();
  const releaseJson = string(fields.releaseJson);
  if (
    Buffer.byteLength(releaseJson) >
    CALLABLE_TARGET_ASSESSMENT_LIMITS.envelopeBytes
  )
    throw new AuthoringValidationUnavailableError('payload_limit');
  return {
    epoch: fields.epoch,
    fingerprint: boundedToken(fields.fingerprint),
    releaseJson,
  };
}
export function parseCallableTargetAssessmentSnapshot(
  input: unknown,
): CallableTargetAssessmentSnapshot {
  const fields = assessmentRecord(input, [
    'purpose',
    'version',
    'workspaceId',
    'currentRelease',
    'entries',
  ]);
  if (
    fields.purpose !== CALLABLE_TARGET_ASSESSMENT_PURPOSE ||
    fields.version !== 1
  )
    invalidAssessment();
  const seen = new Set<string>();
  let sourceBytes = 0;
  let executableBytes = 0;
  const currentRelease = release(fields.currentRelease);
  let rawEnvelopeBytes = Buffer.byteLength(currentRelease.releaseJson);
  const entries = assessmentArray(
    fields.entries,
    CALLABLE_TARGET_ASSESSMENT_LIMITS.uniqueVersions,
  ).map((entry): CallableTargetAssessmentEntry => {
    const row = assessmentRecord(entry, [
      'workflowId',
      'versionId',
      'sourceJson',
      'executableJson',
      'checksum',
      'callableContractIdentity',
      'admissionRelease',
    ]);
    const versionId = identifier(row.versionId);
    if (seen.has(versionId)) invalidAssessment();
    seen.add(versionId);
    const sourceJson = string(row.sourceJson);
    const executableJson = string(row.executableJson);
    sourceBytes += Buffer.byteLength(sourceJson);
    executableBytes += Buffer.byteLength(executableJson);
    if (
      sourceBytes > CALLABLE_TARGET_ASSESSMENT_LIMITS.sourceBytes ||
      executableBytes > CALLABLE_TARGET_ASSESSMENT_LIMITS.executableBytes
    )
      throw new AuthoringValidationUnavailableError('payload_limit');
    if (
      row.callableContractIdentity !== null &&
      typeof row.callableContractIdentity !== 'string'
    )
      invalidAssessment();
    const admissionRelease = release(row.admissionRelease);
    rawEnvelopeBytes +=
      Buffer.byteLength(sourceJson) +
      Buffer.byteLength(executableJson) +
      Buffer.byteLength(admissionRelease.releaseJson);
    if (rawEnvelopeBytes > CALLABLE_TARGET_ASSESSMENT_LIMITS.envelopeBytes)
      throw new AuthoringValidationUnavailableError('payload_limit');
    return {
      workflowId: identifier(row.workflowId),
      versionId,
      sourceJson,
      executableJson,
      checksum: boundedToken(row.checksum),
      callableContractIdentity:
        row.callableContractIdentity === null
          ? null
          : boundedToken(row.callableContractIdentity),
      admissionRelease,
    };
  });
  if (entries.length === 0) invalidAssessment();
  const snapshot: CallableTargetAssessmentSnapshot = {
    purpose: CALLABLE_TARGET_ASSESSMENT_PURPOSE,
    version: 1,
    workspaceId: identifier(fields.workspaceId),
    currentRelease,
    entries,
  };
  if (
    Buffer.byteLength(JSON.stringify(snapshot)) >
    CALLABLE_TARGET_ASSESSMENT_LIMITS.envelopeBytes
  )
    throw new AuthoringValidationUnavailableError('payload_limit');
  return snapshot;
}

export function parseCallableTargetAssessmentReport(
  input: unknown,
  snapshot: CallableTargetAssessmentSnapshot,
): CallableTargetAssessmentReport {
  // Read discriminant without invoking arbitrary getters.
  if (input === null || typeof input !== 'object') invalidAssessment();
  const status = Object.getOwnPropertyDescriptor(input, 'status');
  if (status === undefined || !('value' in status)) invalidAssessment();
  if (status.value === 'budget_exhausted') {
    assessmentRecord(input, ['status']);
    return { status: 'budget_exhausted' };
  }
  if (status.value === 'unavailable') {
    const fields = assessmentRecord(input, ['status', 'reason']);
    if (fields.reason !== 'compatibility_support_unavailable')
      invalidAssessment();
    return { status: 'unavailable', reason: fields.reason };
  }
  if (status.value === 'operational_failure') {
    const fields = assessmentRecord(input, ['status', 'reason']);
    if (
      fields.reason !== 'stored_data_invalid' &&
      fields.reason !== 'immutable_identity_mismatch' &&
      fields.reason !== 'unexpected_verification_failure'
    )
      invalidAssessment();
    return { status: 'operational_failure', reason: fields.reason };
  }
  const fields = assessmentRecord(input, [
    'status',
    'workspaceId',
    'entries',
    'counters',
  ]);
  if (
    fields.status !== 'verified' ||
    fields.workspaceId !== snapshot.workspaceId
  )
    invalidAssessment();
  const rows = assessmentArray(
    fields.entries,
    CALLABLE_TARGET_ASSESSMENT_LIMITS.uniqueVersions,
  );
  if (rows.length !== snapshot.entries.length) invalidAssessment();
  const entries = rows.map((row, index): CallableTargetAssessmentFact => {
    const item = assessmentRecord(row, [
      'workflowId',
      'versionId',
      'checksum',
      'pin',
      'contract',
    ]);
    const submitted = snapshot.entries[index];
    if (
      submitted === undefined ||
      item.workflowId !== submitted.workflowId ||
      item.versionId !== submitted.versionId ||
      item.checksum !== submitted.checksum
    )
      invalidAssessment();
    if (item.pin === null) {
      if (item.contract !== null || submitted.callableContractIdentity !== null)
        invalidAssessment();
      return {
        workflowId: submitted.workflowId,
        versionId: submitted.versionId,
        checksum: submitted.checksum,
        pin: null,
        contract: null,
      };
    }
    const pin = workflowCallPinSchemaV1.parse(
      assessmentRecord(item.pin, [
        'workflowId',
        'versionId',
        'checksum',
        'callableContractIdentity',
      ]),
    );
    if (
      pin.workflowId !== submitted.workflowId ||
      pin.versionId !== submitted.versionId ||
      pin.checksum !== submitted.checksum ||
      pin.callableContractIdentity !== submitted.callableContractIdentity
    )
      invalidAssessment();
    const contract = assessmentRecord(item.contract, ['input', 'result']);
    return {
      workflowId: submitted.workflowId,
      versionId: submitted.versionId,
      checksum: submitted.checksum,
      pin,
      contract: {
        input: callableObjectTypeDescriptorSchemaV1.parse(contract.input),
        result: callableObjectTypeDescriptorSchemaV1.parse(contract.result),
      },
    };
  });
  const keys = [
    'uniqueVersions',
    'sourceBytes',
    'executableBytes',
    'envelopeBytes',
    'members',
    'nodeVisits',
  ] as const;
  const counts = assessmentRecord(fields.counters, keys);
  function boundedCounter(key: (typeof keys)[number]): number {
    const value = counts[key];
    const maximum = CALLABLE_TARGET_ASSESSMENT_LIMITS[key];
    if (
      typeof value !== 'number' ||
      !Number.isSafeInteger(value) ||
      value < 0 ||
      value > maximum
    )
      invalidAssessment();
    return value;
  }
  const counters: CallableTargetAssessmentCounters = {
    uniqueVersions: boundedCounter('uniqueVersions'),
    sourceBytes: boundedCounter('sourceBytes'),
    executableBytes: boundedCounter('executableBytes'),
    envelopeBytes: boundedCounter('envelopeBytes'),
    members: boundedCounter('members'),
    nodeVisits: boundedCounter('nodeVisits'),
  };
  if (
    counters.uniqueVersions !== snapshot.entries.length ||
    counters.sourceBytes !==
      snapshot.entries.reduce(
        (sum, row) => sum + Buffer.byteLength(row.sourceJson),
        0,
      ) ||
    counters.executableBytes !==
      snapshot.entries.reduce(
        (sum, row) => sum + Buffer.byteLength(row.executableJson),
        0,
      ) ||
    counters.envelopeBytes !== Buffer.byteLength(JSON.stringify(snapshot))
  )
    invalidAssessment();
  const report: CallableTargetAssessmentReport = {
    status: 'verified',
    workspaceId: snapshot.workspaceId,
    entries,
    counters,
  };
  if (
    Buffer.byteLength(JSON.stringify(report)) >
    CALLABLE_TARGET_ASSESSMENT_LIMITS.reportBytes
  )
    throw new AuthoringValidationUnavailableError('report_limit');
  return report;
}
