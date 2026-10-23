import { utf8ByteLength } from '../text.js';
import { z } from 'zod';
import { parseJsonPath } from './path.js';

export const collectionPathSchema = z
  .string()
  .min(1)
  .max(512)
  .superRefine((path, context) => {
    const segments = parseJsonPath(path);
    if (
      utf8ByteLength(path) > 512 ||
      segments === undefined ||
      segments.length > 64
    )
      context.addIssue({
        code: 'custom',
        message:
          'Write the path like $.status or $.items[0].id, with at most 512 UTF-8 bytes and 64 segments',
      });
  })
  // Lets the editor accept a bare field name and store it as a path.
  .meta({ format: 'json-path' });
