import { expect, it } from 'vitest';
import { z } from 'zod';
import { generateSchemaDocument, labelledChoice } from '../../src/index.js';

it('stores the IDs and names each one in standard JSON Schema', () => {
  const algorithm = labelledChoice({ sha256: 'SHA-256', md5: 'MD5' });
  expect(algorithm.parse('md5')).toBe('md5');
  expect(algorithm.safeParse('SHA-256').success).toBe(false);
  const document = generateSchemaDocument(
    z.object({ algorithm: algorithm.meta({ title: 'Algorithm' }) }).strict(),
  );
  expect(document).toMatchObject({
    properties: {
      algorithm: {
        type: 'string',
        enum: ['sha256', 'md5'],
        title: 'Algorithm',
        oneOf: [
          { const: 'sha256', title: 'SHA-256' },
          { const: 'md5', title: 'MD5' },
        ],
      },
    },
  });
});
