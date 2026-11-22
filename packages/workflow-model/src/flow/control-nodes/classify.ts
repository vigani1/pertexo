import { z } from 'zod';

export const CLASSIFY_STEP = Object.freeze({ key: 'ai.classify', version: 1 });
export const CLASSIFY_OTHER_PORT = 'other';
export const CLASSIFY_CATEGORY_PORTS = Object.freeze([
  'category-01',
  'category-02',
  'category-03',
  'category-04',
  'category-05',
  'category-06',
  'category-07',
  'category-08',
] as const);
export const CLASSIFY_CATEGORY_LIMITS = {
  labelCharacters: 80,
  descriptionCharacters: 1_024,
} as const;

const classifyCategorySchema = z.strictObject({
  id: z.enum(CLASSIFY_CATEGORY_PORTS),
  label: z.string().trim().min(1).max(CLASSIFY_CATEGORY_LIMITS.labelCharacters),
  description: z
    .string()
    .trim()
    .min(1)
    .max(CLASSIFY_CATEGORY_LIMITS.descriptionCharacters),
});

export type ClassifyCategory = z.output<typeof classifyCategorySchema>;

export const classifyCategoriesSchema = z
  .array(classifyCategorySchema)
  .min(1)
  .max(CLASSIFY_CATEGORY_PORTS.length)
  .superRefine((categories, context) => {
    const ids = new Set<string>();
    const labels = new Set<string>();
    for (const [index, { id, label }] of categories.entries()) {
      const normalized = label.toLowerCase();
      if (ids.has(id))
        context.addIssue({
          code: 'custom',
          path: [index, 'id'],
          message: 'Category IDs must be unique',
        });
      if (labels.has(normalized))
        context.addIssue({
          code: 'custom',
          path: [index, 'label'],
          message: 'Category labels must be unique',
        });
      ids.add(id);
      labels.add(normalized);
    }
  });

export function isClassifyDefinition(
  definition: Readonly<{ key: string; version: number }> | undefined,
): boolean {
  return (
    definition?.key === CLASSIFY_STEP.key &&
    definition.version === CLASSIFY_STEP.version
  );
}

export function classifyOutputPorts(
  categories: readonly Pick<ClassifyCategory, 'id'>[],
) {
  return [...categories.map(({ id }) => id), CLASSIFY_OTHER_PORT];
}
