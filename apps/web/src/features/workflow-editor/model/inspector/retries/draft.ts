import {
  DEFAULT_STEP_RETRY_SETTINGS,
  STEP_RETRY_LIMITS,
  type StepRetrySettings,
} from '@pertexo/workflow-model';
import type { WorkflowGraphContract } from '@pertexo/contracts';
import type { NodeFormApi } from '../node-form';
import type { SchemaFieldSpec } from '../draft';

type WorkflowNode = WorkflowGraphContract['nodes'][number];

export const retryPolicyLabels = {
  default: 'Platform default',
  none: 'Do not retry',
  custom: 'Custom',
} as const;
export const retryModes = Object.entries(retryPolicyLabels).map(
  ([value, label]) => ({ value, label }),
);
export function stepRetryMode(settings: StepRetrySettings | undefined) {
  if (settings === undefined) {
    return 'default';
  }
  if (settings.maximumAttempts === 1) {
    return 'none';
  }
  return 'custom';
}
export function retrySettingsForMode(
  mode: string,
  node: WorkflowNode,
): StepRetrySettings | undefined {
  if (mode === 'default') return undefined;
  const previous = node.retry ?? DEFAULT_STEP_RETRY_SETTINGS;
  return {
    ...previous,
    maximumAttempts: attemptsForMode(mode, previous),
  };
}
export function shownRetrySettings(node: WorkflowNode) {
  const settings = node.retry ?? DEFAULT_STEP_RETRY_SETTINGS;
  return {
    maximumAttempts: settings.maximumAttempts,
    delaySeconds: settings.delayMillis / 1_000,
  };
}

export const retryFields: readonly SchemaFieldSpec[] = [
  {
    key: 'maximumAttempts',
    label: 'Max tries',
    kind: 'integer',
    required: true,
    minimum: 2,
    maximum: STEP_RETRY_LIMITS.maximumAttempts,
    description:
      'Includes the first try. Three tries means at most two retries.',
  },
  {
    key: 'delaySeconds',
    label: 'Wait between tries',
    kind: 'integer',
    required: true,
    unit: 'seconds',
    minimum: STEP_RETRY_LIMITS.minimumDelayMillis / 1_000,
    maximum: STEP_RETRY_LIMITS.maximumDelayMillis / 1_000,
    description:
      'A fixed wait in whole seconds. A service may request a longer wait.',
  },
];

/** Fields edit the current node, even if another setting changed since render. */
export function stepRetryForm(form: NodeFormApi): NodeFormApi {
  return {
    ...form,
    nodeId: `${form.nodeId}:retry`,
    reportScratch: (field, scratch) => {
      form.reportScratch(`retry:${field}`, scratch);
    },
    commit: (update, key) => {
      form.commit((node) => {
        const change =
          typeof update === 'function'
            ? update({ ...node, config: shownRetrySettings(node) })
            : update;
        const config = change.config;
        if (config === undefined) return {};
        return {
          retry: {
            maximumAttempts: Number(config.maximumAttempts),
            delayMillis: Number(config.delaySeconds) * 1_000,
          },
        };
      }, `retry:${key}`);
    },
  };
}

export function describeStepRetrySettings(
  settings: StepRetrySettings | undefined,
): string {
  if (settings === undefined)
    return 'Up to three total tries for eligible failures, with increasing waits and jitter.';
  if (settings.maximumAttempts === 1)
    return 'One try. Temporary failures are not retried.';
  const seconds = settings.delayMillis / 1_000;
  return `Up to ${String(settings.maximumAttempts)} total tries for eligible failures, waiting ${String(seconds)} ${seconds === 1 ? 'second' : 'seconds'} between tries.`;
}

function attemptsForMode(mode: string, previous: StepRetrySettings): number {
  if (mode === 'none') return 1;
  return previous.maximumAttempts === 1
    ? DEFAULT_STEP_RETRY_SETTINGS.maximumAttempts
    : previous.maximumAttempts;
}
