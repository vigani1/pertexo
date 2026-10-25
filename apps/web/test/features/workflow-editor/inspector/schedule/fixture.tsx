import {
  draftFromConfig,
  readScheduleSchema,
  type ScheduleDraft,
  type ScheduleSchema,
} from '@/features/workflow-editor/model/inspector/schedule-draft';
import type {
  NodeDefinitionCatalogItem,
  WorkflowGraphContract,
} from '@pertexo/contracts';
import { HttpResponse, http } from 'msw';
import {
  setDefinition,
  workflowApi,
} from '../../../../support/fixtures/workflow-editor';
const misfirePolicy = {
  default: 'catch_up_once',
  type: 'string',
  enum: ['catch_up_once', 'skip'],
};

const scheduleConfigSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  oneOf: [
    {
      type: 'object',
      properties: {
        kind: { type: 'string', const: 'cron' },
        expression: { type: 'string', minLength: 9, maxLength: 255 },
        timezone: { type: 'string', minLength: 1, maxLength: 255 },
        misfirePolicy,
      },
      required: ['kind', 'expression', 'timezone', 'misfirePolicy'],
      additionalProperties: false,
    },
    {
      type: 'object',
      properties: {
        kind: { type: 'string', const: 'interval' },
        intervalMinutes: { type: 'integer', minimum: 1, maximum: 43_200 },
        misfirePolicy,
      },
      required: ['kind', 'intervalMinutes', 'misfirePolicy'],
      additionalProperties: false,
    },
  ],
};

export const scheduleDefinition = {
  ...setDefinition,
  definition: { key: 'core.schedule', version: 1 },
  family: 'trigger',
  configVersion: 1,
  configSchema: scheduleConfigSchema,
  ports: { inputs: [], outputs: ['out'] },
} satisfies NodeDefinitionCatalogItem;

export function readSchema(): ScheduleSchema {
  const schema = readScheduleSchema(scheduleConfigSchema);
  if (schema === undefined) throw new Error('schedule schema not understood');
  return schema;
}

export function draftOf(config: Record<string, unknown>): ScheduleDraft {
  return draftFromConfig(config as never, readSchema(), 'Europe/Berlin');
}

export function previewHandler(sent: unknown[] = []) {
  return http.post(
    `${workflowApi}/triggers/schedules/preview`,
    async ({ request }) => {
      const body: unknown = await request.json();
      sent.push(body);
      if (JSON.stringify(body).includes('"0 25 * * *"'))
        return HttpResponse.json(
          {
            type: 'about:blank',
            title: 'Invalid request',
            status: 400,
            code: 'request.invalid',
          },
          { status: 400 },
        );
      return HttpResponse.json({
        observedAt: '2027-03-12T12:00:00.000Z',
        items: [
          { scheduledAt: '2027-03-13T07:30:00.000Z' },
          { scheduledAt: '2027-03-14T07:00:00.000Z' },
          { scheduledAt: '2027-03-15T06:30:00.000Z' },
        ],
      });
    },
  );
}

export function scheduleGraph(
  config: WorkflowGraphContract['nodes'][number]['config'],
): WorkflowGraphContract {
  return {
    nodes: [
      {
        id: 'nightly',
        label: 'Nightly',
        definition: { key: 'core.schedule', version: 1 },
        position: { x: 80, y: 80 },
        configVersion: 1,
        config,
        inputMappings: {},
        connectionRefs: {},
      },
    ],
    edges: [],
    settings: {},
  };
}
