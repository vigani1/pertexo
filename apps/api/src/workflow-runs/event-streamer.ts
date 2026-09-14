import {
  workflowRunEventPayloadSchema,
  workflowRunEventSchema,
} from '@pertexo/contracts/workflow-runs';
import { z } from 'zod';

import {
  streamRunEventFrames,
  type LiveRunEventSource,
  type PersistedRunEventReader,
} from '../executions/index.js';
import type { SseRunEventFrame } from '../executions/run-event-stream.js';
import type {
  WorkflowRunEventFrame,
  WorkflowRunEventStreamer,
} from './ports.js';

const payloadRecordSchema = z.record(z.string(), z.unknown());
const rawPersistedEventSchema = z
  .object({
    sequence: z.number().int().positive(),
    type: z.string(),
    createdAt: z.iso.datetime({ offset: true }),
    payload: z.unknown(),
  })
  .strict();
const PUBLIC_PAYLOAD_KEYS = Object.freeze([
  'schemaVersion',
  'invocationKey',
  'nodeId',
  'nodeRunId',
  'attemptId',
  'attemptNumber',
  'dueAt',
  'safeErrorCode',
  'reasonCode',
  'outputRef',
] as const);

export function createWorkflowRunEventStreamer(
  reader: PersistedRunEventReader,
  liveSource: LiveRunEventSource,
): WorkflowRunEventStreamer {
  return Object.freeze({
    stream: (input: Parameters<WorkflowRunEventStreamer['stream']>[0]) =>
      publicFrames(input, reader, liveSource),
  });
}

async function* publicFrames(
  input: Parameters<WorkflowRunEventStreamer['stream']>[0],
  reader: PersistedRunEventReader,
  liveSource: LiveRunEventSource,
): AsyncGenerator<WorkflowRunEventFrame> {
  for await (const frame of streamRunEventFrames(input, {
    reader,
    liveSource,
  })) {
    yield projectPublicFrame(frame, input.onProducerFailure);
  }
}

function projectPublicFrame(
  frame: SseRunEventFrame,
  onProducerFailure: ((error: unknown) => void) | undefined,
): WorkflowRunEventFrame {
  try {
    const raw = rawPersistedEventSchema.parse(
      JSON.parse(frame.data) as unknown,
    );
    const payload = payloadRecordSchema.parse(raw.payload);
    const projected: Record<string, unknown> = {};
    for (const key of PUBLIC_PAYLOAD_KEYS) {
      if (Object.hasOwn(payload, key)) projected[key] = payload[key];
    }
    const event = workflowRunEventSchema.parse({
      sequence: raw.sequence,
      type: raw.type,
      createdAt: raw.createdAt,
      payload: workflowRunEventPayloadSchema.parse(projected),
    });
    return Object.freeze({
      id: event.sequence,
      event: event.type,
      data: JSON.stringify(event),
      visibilityPath: frame.visibilityPath,
    });
  } catch (error) {
    try {
      onProducerFailure?.(error);
    } catch {
      // Failure notification cannot replace the projection error.
    }
    throw error;
  }
}
