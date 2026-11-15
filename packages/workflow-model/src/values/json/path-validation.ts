import { utf8ByteLength } from '../text.js';
import { z } from 'zod';
import { parseJsonPath } from './path.js';

export const COLLECTION_PATH_LIMITS = Object.freeze({
  bytes: 512,
  segments: 64,
});

export const collectionPathSchema = z
  .string()
  .min(1)
  .max(COLLECTION_PATH_LIMITS.bytes)
  .superRefine((path, context) => {
    const segments = parseJsonPath(path);
    if (
      utf8ByteLength(path) > COLLECTION_PATH_LIMITS.bytes ||
      segments === undefined ||
      segments.length > COLLECTION_PATH_LIMITS.segments
    )
      context.addIssue({
        code: 'custom',
        message: `Write the path like $.status or $.items[0].id, with at most ${String(COLLECTION_PATH_LIMITS.bytes)} UTF-8 bytes and ${String(COLLECTION_PATH_LIMITS.segments)} segments`,
      });
  })
  // Lets the editor accept a bare field name and store it as a path.
  .meta({ format: 'json-path' });
