import { z } from 'zod';

export const SWITCH_CASE_PORTS = Object.freeze([
  'case-01',
  'case-02',
  'case-03',
  'case-04',
  'case-05',
  'case-06',
  'case-07',
  'case-08',
  'case-09',
  'case-10',
  'case-11',
  'case-12',
  'case-13',
  'case-14',
  'case-15',
  'case-16',
] as const);

const switchCasePortSchema = z.enum(SWITCH_CASE_PORTS);
export const switchScalarSchema = z.union([
  z.null(),
  z.boolean(),
  z.number(),
  z.string().max(1_024),
]);
export const switchConfigSchema = z
  .object({
    cases: z
      .array(
        z
          .object({
            id: switchCasePortSchema,
            equals: switchScalarSchema,
          })
          .strict(),
      )
      .min(1)
      .max(SWITCH_CASE_PORTS.length),
  })
  .strict()
  .superRefine(({ cases }, context) => {
    if (new Set(cases.map(({ id }) => id)).size !== cases.length)
      context.addIssue({
        code: 'custom',
        path: ['cases'],
        message: 'Switch case IDs must be unique',
      });
  });

export type SwitchConfig = Readonly<z.output<typeof switchConfigSchema>>;
