import './server-only.js';

import { createHash } from 'node:crypto';

import { parseQueueJob, type QueueJob } from './contracts.js';

function canonicalJson(value: unknown): string {
  if (value === null) {
    return 'null';
  }

  switch (typeof value) {
    case 'string':
    case 'boolean':
      return JSON.stringify(value);
    case 'number':
      if (!Number.isFinite(value)) {
        throw new TypeError(
          'Canonical queue JSON cannot contain non-finite numbers',
        );
      }
      return JSON.stringify(value);
    case 'object':
      if (Array.isArray(value)) {
        return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
      }

      return `{${Object.keys(value)
        .sort()
        .map(
          (key) =>
            `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`,
        )
        .join(',')}}`;
    default:
      throw new TypeError('Canonical queue JSON contains an unsupported value');
  }
}

export function canonicalizeQueueJob(job: QueueJob): string {
  const parsed = parseQueueJob(job);

  return canonicalJson({ name: parsed.name, data: parsed.data });
}

export function canonicalizeQueueJobData(job: QueueJob): string {
  return canonicalJson(parseQueueJob(job).data);
}

export function queueJobChecksum(job: QueueJob): string {
  return createHash('sha256')
    .update(canonicalizeQueueJobData(job), 'utf8')
    .digest('hex');
}

export function queueJobEnvelopeChecksum(job: QueueJob): string {
  return createHash('sha256')
    .update(canonicalizeQueueJob(job), 'utf8')
    .digest('hex');
}
