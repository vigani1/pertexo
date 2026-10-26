import { expect } from 'vitest';
import { z } from 'zod';
import { emailDeliveries } from '../../fixture/state.js';

/** What the worker's Resend stand-in received, reported over IPC. */
export const emailDeliveriesSchema = z
  .object({
    phase: z.literal('email-deliveries'),
    emails: z
      .array(
        z
          .object({
            to: z.string().max(254),
            subject: z.string().max(200),
            attachments: z
              .array(
                z
                  .object({
                    filename: z.string().max(255),
                    contentType: z.string().max(255),
                    byteLength: z.number().int().min(0),
                    sha256: z.string().regex(/^[a-f0-9]{64}$/u),
                    text: z.string().max(4096).optional(),
                  })
                  .strict(),
              )
              .max(10),
          })
          .strict(),
      )
      .max(16),
  })
  .strict();

export type DeliveredEmail = z.infer<
  typeof emailDeliveriesSchema
>['emails'][number];

/** One email reached Resend, carrying the CSV that Create file made. */
export function verifyEditorEmailAttachmentsOutcome() {
  expect(emailDeliveries).toHaveLength(1);
  expect(emailDeliveries[0]).toMatchObject({
    subject: 'Weekly report',
    attachments: [
      {
        filename: 'weekly-report.csv',
        contentType: 'text/csv; charset=utf-8',
        text: '"week","total"\r\n"42","1200"\r\n',
      },
    ],
  });
}
