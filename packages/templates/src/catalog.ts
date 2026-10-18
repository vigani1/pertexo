import type { WorkflowPortableManifest } from '@pertexo/workflow-model';

import { CONTROLLED_HTTP_NOTIFICATION_MANIFEST } from './manifests/controlled-http-notification.js';
import { SCHEDULE_BOUNDED_BATCH_MANIFEST } from './manifests/schedule-bounded-batch.js';
import { WEBHOOK_VALIDATION_ROUTING_MANIFEST } from './manifests/webhook-validation-routing.js';

export type CuratedTemplateSetupValueKind =
  'https_endpoint' | 'slack_channel_id';
export interface CuratedTemplateSetupTarget {
  readonly nodeId: string;
  readonly location: 'config' | 'literalInput';
  readonly key: string;
  readonly valueKind: CuratedTemplateSetupValueKind;
}
export interface CuratedWorkflowTemplate {
  readonly templateId: string;
  readonly templateVersion: number;
  readonly baseManifestDigest: string;
  readonly title: string;
  readonly description: string;
  readonly inputSummary: string;
  readonly effectsSummary: string;
  readonly boundsSummary: string;
  readonly manifest: WorkflowPortableManifest;
  readonly setupTargets: readonly CuratedTemplateSetupTarget[];
}

function freezeJson<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) freezeJson(child);
    Object.freeze(value);
  }
  return value;
}

const templates: CuratedWorkflowTemplate[] = [
  {
    templateId: 'webhook-validation-routing',
    templateVersion: 2,
    baseManifestDigest:
      '61c486c65452bfa093ae9cf2c6464848c42415f0298ab23100a885e4226a9115',
    title: 'Validate and route a webhook',
    description:
      'Check that each incoming request is the kind you expect, then accept it or turn it away.',
    inputSummary:
      'A webhook request with JSON like {"type":"notification"}. Anything else is turned away.',
    effectsSummary:
      'Only checks and routes the request; it calls no outside service. It runs once you publish it and give the webhook an address.',
    boundsSummary:
      'Up to five step runs, no loops; runs stop after five minutes.',
    manifest: WEBHOOK_VALIDATION_ROUTING_MANIFEST,
    setupTargets: [],
  },
  {
    templateId: 'schedule-bounded-batch',
    templateVersion: 2,
    baseManifestDigest:
      '025cc93c5a99a3601e7099a3b12cb438d6e4dedb383d5bcfcad0d17050bd3683',
    title: 'Work through a small batch on a schedule',
    description:
      'Every hour, go through a short list one item at a time. Copy the pattern for your own lists.',
    inputSummary:
      'An hourly schedule. The list holds two fixed example items, not data from the trigger.',
    effectsSummary:
      'Only sets values inside the run; it calls no outside service. It runs once you publish it and turn the schedule on.',
    boundsSummary:
      'At most three items, one at a time, six step runs in all; runs stop after five minutes.',
    manifest: SCHEDULE_BOUNDED_BATCH_MANIFEST,
    setupTargets: [],
  },
  {
    templateId: 'controlled-http-notification',
    templateVersion: 2,
    baseManifestDigest:
      'd1c649a2706e36de15f4101a775a531188eb66f318bf2e047e96648e24ea8b95',
    title: 'Check an endpoint and notify Slack',
    description:
      'Call an HTTPS address you choose and post to a Slack channel when it answers 200.',
    inputSummary:
      'A webhook starts it. Before creating it, enter your address and channel and pick an HTTP and a Slack connection.',
    effectsSummary:
      'Once published and run, it makes one GET request and may send one Slack message. Other 2xx answers skip Slack; errors fail the run or leave its outcome unknown. The sample values don’t run until you replace them.',
    boundsSummary:
      'No redirects or loops; one-second timeouts, answers up to 1,024 bytes, six step runs in all; runs stop after five minutes.',
    manifest: CONTROLLED_HTTP_NOTIFICATION_MANIFEST,
    setupTargets: [
      {
        nodeId: 'controlled-http',
        location: 'config',
        key: 'url',
        valueKind: 'https_endpoint',
      },
      {
        nodeId: 'slack-notification',
        location: 'literalInput',
        key: 'channelId',
        valueKind: 'slack_channel_id',
      },
    ],
  },
];

/** Public instructional assets, not capability/selection authority or a safety assertion. */
export const CURATED_WORKFLOW_TEMPLATES: readonly CuratedWorkflowTemplate[] =
  freezeJson(templates);
