import { describe, expect, it } from 'vitest';
import {
  EMAIL_SEND_NOTIFICATION_LIMITS,
  emailSendNotificationInputSchema,
  encodedAttachmentBytes,
} from '../../../src/index.js';
import { planAttachments } from '../../../src/email/attachments/plan.js';

function file(byteLength: number, mediaType = 'text/csv') {
  return {
    kind: 'artifact' as const,
    artifactId: crypto.randomUUID(),
    byteLength,
    mediaType,
    sha256: 'a'.repeat(64),
  };
}

describe('planning email attachments', () => {
  it('accepts old input without attachments and a list of file references', () => {
    const base = { toEmail: 'a@example.com', subject: 'x', text: 'x' };
    expect(emailSendNotificationInputSchema.safeParse(base).success).toBe(true);
    expect(
      emailSendNotificationInputSchema.safeParse({
        ...base,
        attachments: [{ file: file(10) }, { file: file(4), filename: 'a.csv' }],
      }).success,
    ).toBe(true);
    for (const attachments of [
      [{ file: { ...file(1), kind: 'inline' } }],
      [{ file: { artifactId: crypto.randomUUID() } }],
      [{ file: file(1), name: 'extra.csv' }],
      [{ file: file(1), filename: 'x'.repeat(1_025) }],
    ])
      expect(
        emailSendNotificationInputSchema.safeParse({ ...base, attachments })
          .success,
      ).toBe(false);
  });

  it('measures the total after base64 encoding, as Resend does', () => {
    expect(encodedAttachmentBytes(0)).toBe(0);
    expect(encodedAttachmentBytes(1)).toBe(4);
    expect(encodedAttachmentBytes(3)).toBe(4);
    expect(encodedAttachmentBytes(4)).toBe(8);
    const limit = EMAIL_SEND_NOTIFICATION_LIMITS.maxAttachmentEncodedBytes;
    const fitting = (limit / 4) * 3;
    expect(() => planAttachments([{ file: file(fitting) }])).not.toThrow();
    expect(() => planAttachments([{ file: file(fitting + 1) }])).toThrow(
      expect.objectContaining({
        safeErrorCode: 'email.attachments_too_large',
        kind: 'failed',
        errorKind: 'configuration',
        possiblyDispatched: false,
      }),
    );
    // These fit the limit as raw bytes, but each file pads to whole quads.
    const padded = [
      { file: file(fitting / 2 - 1) },
      { file: file(fitting / 2 - 1) },
      { file: file(1) },
    ];
    expect(
      padded.reduce((total, { file: { byteLength } }) => total + byteLength, 0),
    ).toBeLessThanOrEqual(fitting);
    expect(() => planAttachments(padded)).toThrow(
      expect.objectContaining({ safeErrorCode: 'email.attachments_too_large' }),
    );
  });

  it('refuses more than ten files before reading any', () => {
    const files = Array.from({ length: 11 }, () => ({ file: file(1) }));
    expect(() => planAttachments(files.slice(0, 10))).not.toThrow();
    expect(() => planAttachments(files)).toThrow(
      expect.objectContaining({
        safeErrorCode: 'email.too_many_attachments',
        errorSummary: expect.stringContaining('at most 10') as unknown,
      }),
    );
  });

  it('names each file from its override or its media type', () => {
    expect(
      planAttachments([
        { file: file(3, 'application/pdf') },
        { file: file(3), filename: 'reports/weekly.csv' },
        { file: file(3, 'image/png'), filename: '\u0000' },
      ]).map(({ filename, contentType, reference }) => ({
        filename,
        contentType,
        hasKind: 'kind' in reference,
      })),
    ).toEqual([
      {
        filename: 'attachment-1.pdf',
        contentType: 'application/pdf',
        hasKind: false,
      },
      {
        filename: 'reportsweekly.csv',
        contentType: 'text/csv',
        hasKind: false,
      },
      {
        filename: 'attachment-3.png',
        contentType: 'image/png',
        hasKind: false,
      },
    ]);
  });
});
