import { describe, expect, it } from 'vitest';
import {
  assertFormFileSize,
  attachFormFiles,
  FORM_FILE_LIMITS,
  FormFileRejectedError,
  formFieldsSchema,
  formFileMatchesType,
  formFilename,
  formFileType,
  formSubmissionSchema,
  formFileUploads,
  FormValuesInvalidError,
  inputRequestConfigSchema,
  parseFormValues,
  parseTaskPrefill,
  type FormFileValue,
} from '../../src/index.js';

const fields = formFieldsSchema.parse([
  {
    id: 'invoice',
    name: 'invoice',
    label: 'Invoice',
    type: 'file',
    accept: ['documents'],
  },
  {
    id: 'photos',
    name: 'photos',
    label: 'Photos',
    type: 'file',
    required: false,
    accept: ['images', 'spreadsheets'],
    maxFiles: 3,
    maxBytes: 1_048_576,
  },
]);
const [invoice, photos] = fields;
const upload = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const text = (value: string) => new TextEncoder().encode(value);
const bytes = (...values: number[]) => Uint8Array.from(values);

function fieldErrors(run: () => unknown) {
  try {
    run();
  } catch (error) {
    if (error instanceof FormValuesInvalidError) return error.fields;
    throw error;
  }
  throw new Error('Expected the response to be refused');
}

describe('file field setup', () => {
  it('defaults to one file of up to 5 MB and keeps chosen limits', () => {
    expect(invoice).toMatchObject({ maxFiles: 1, maxBytes: 5_242_880 });
    expect(photos).toMatchObject({ maxFiles: 3, maxBytes: 1_048_576 });
  });

  it.each([
    [{ accept: [] }, 'Choose at least one kind of file.'],
    [{ accept: ['images', 'images'] }, 'Choose each kind of file once.'],
    [{ accept: ['videos'] }, undefined],
    [{ maxFiles: 0 }, undefined],
    [{ maxFiles: 6 }, undefined],
    [{ maxBytes: 10 * 1_048_576 + 1 }, 'Keep each file within 10 MB.'],
  ])('refuses setup outside the limits (%j)', (override, message) => {
    const result = formFieldsSchema.safeParse([
      {
        id: 'f',
        name: 'f',
        label: 'F',
        type: 'file',
        accept: ['documents'],
        ...override,
      },
    ]);
    expect(result.success).toBe(false);
    if (message !== undefined)
      expect(result.error?.issues.map((issue) => issue.message)).toContain(
        message,
      );
  });

  it('works in Request input with the same field model', () => {
    const config = inputRequestConfigSchema.parse({ fields: [invoice] });
    expect(config.fields[0]).toEqual(invoice);
  });
});

describe('file values', () => {
  it('accepts upload IDs within the count and omits an optional empty list', () => {
    expect(
      parseFormValues(fields, { invoice: [upload(1)], photos: [] }),
    ).toEqual({ invoice: [upload(1)] });
    expect(
      parseFormValues(fields, {
        invoice: [upload(1)],
        photos: [upload(2), upload(3), upload(4)],
      }).photos,
    ).toHaveLength(3);
  });

  it.each([
    [{ invoice: [] }, 'invoice', 'Attach a file.'],
    [{ invoice: [upload(1), upload(2)] }, 'invoice', 'Attach up to 1 file.'],
    [
      { invoice: [upload(1)], photos: [1, 2, 3, 4].map(upload) },
      'photos',
      'Attach up to 3 files.',
    ],
    [
      { invoice: ['not-an-upload'] },
      'invoice',
      'Upload each file again; one of them was not received.',
    ],
  ] as const)('says what is wrong (%j)', (value, name, message) => {
    expect(fieldErrors(() => parseFormValues(fields, value))).toContainEqual({
      name,
      message,
    });
  });

  it('swaps upload IDs for file references and refuses unknown uploads', () => {
    const values = parseFormValues(fields, {
      invoice: [upload(1)],
      photos: [upload(2)],
    });
    expect(
      formFileUploads(fields, values).map(({ uploadIds }) => uploadIds),
    ).toEqual([[upload(1)], [upload(2)]]);
    const file = (n: number): FormFileValue => ({
      file: {
        kind: 'artifact',
        artifactId: upload(n),
        byteLength: 3,
        mediaType: 'application/pdf',
        sha256: 'a'.repeat(64),
      },
      filename: 'invoice.pdf',
    });
    const attached = attachFormFiles(
      fields,
      values,
      new Map([
        [`invoice:${upload(1)}`, file(1)],
        [`photos:${upload(2)}`, file(2)],
      ]),
    );
    expect(attached).toEqual({ invoice: [file(1)], photos: [file(2)] });
    expect(
      formSubmissionSchema.parse({
        values: attached,
        submittedBy: null,
        submittedAt: '2026-10-26T10:00:00.000Z',
      }).values,
    ).toEqual(attached);
    // An upload bound to another field is not this field's file.
    expect(
      fieldErrors(() =>
        attachFormFiles(
          fields,
          values,
          new Map([
            [`invoice:${upload(2)}`, file(2)],
            [`photos:${upload(2)}`, file(2)],
          ]),
        ),
      ),
    ).toEqual([
      {
        name: 'invoice',
        message:
          'A file is no longer available. Remove it and upload it again.',
      },
    ]);
  });

  it('never accepts a file as a Request input prefill', () => {
    expect(
      fieldErrors(() => parseTaskPrefill(fields, { invoice: [upload(1)] })),
    ).toEqual([
      { name: 'invoice', message: 'File fields cannot be prefilled.' },
    ]);
    expect(parseTaskPrefill(fields, {})).toEqual({});
  });
});

describe('file type and size checks', () => {
  it('derives the stored type from an accepted extension', () => {
    expect(formFileType('Scan.PDF', ['documents'])).toEqual({
      extension: 'pdf',
      mediaType: 'application/pdf',
    });
    expect(formFileType('photo.jpeg', ['images']).mediaType).toBe('image/jpeg');
  });

  it.each(['run.exe', 'invoice', 'pdf', 'photo.png'])(
    'refuses %s for documents only',
    (filename) => {
      expect(() => formFileType(filename, ['documents'])).toThrow(
        new FormFileRejectedError(
          'type',
          'This field accepts PDF, Word and text files.',
        ),
      );
    },
  );

  it('names the size in plain words', () => {
    expect(() => {
      assertFormFileSize(12 * 1_048_576, 5 * 1_048_576);
    }).toThrow('This file is 12 MB; the limit is 5 MB.');
    expect(() => {
      assertFormFileSize(1_048_577, 1_048_576);
    }).toThrow('This file is just over the 1 MB limit.');
    expect(() => {
      assertFormFileSize(FORM_FILE_LIMITS.defaultMaxBytes, 5 * 1_048_576);
    }).not.toThrow();
  });

  it('keeps only a clean last path part of a responder file name', () => {
    expect(formFilename('C:\\fakepath\\in\u0007voice.pdf')).toBe('invoice.pdf');
    expect(formFilename('../../etc/passwd.txt')).toBe('passwd.txt');
    expect(Array.from(formFilename(`${'é'.repeat(300)}.txt`))).toHaveLength(
      255,
    );
  });

  it.each([
    ['pdf', text('%PDF-1.7\n'), true],
    ['pdf', text('<html>'), false],
    ['docx', bytes(0x50, 0x4b, 0x03, 0x04, 0x14), true],
    ['xlsx', text('a,b\n1,2'), false],
    ['png', bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a), true],
    ['jpg', bytes(0xff, 0xd8, 0xff, 0xe0), true],
    ['gif', text('GIF89a'), true],
    ['webp', text('RIFF\u0000\u0000\u0000\u0000WEBPVP8 '), true],
    ['heic', text('\u0000\u0000\u0000\u0018ftypheic'), true],
    ['heic', text('\u0000\u0000\u0000\u0018ftypmp42'), false],
    ['csv', text('name,amount\nAlice,12\n'), true],
    ['csv', bytes(0x50, 0x4b, 0x03, 0x04, 0x00), false],
    ['txt', bytes(0xc3), true],
    ['txt', bytes(0xff, 0xfe, 0x41), false],
    ['md', text(''), true],
    ['json', text('\uFEFF  {"a":1}'), true],
    ['json', text('a,b'), false],
    ['xml', text('<?xml version="1.0"?>'), true],
    ['xml', text('%PDF-'), false],
  ] as const)('sniffs %s bytes (%#)', (extension, head, matches) => {
    expect(formFileMatchesType(extension, head)).toBe(matches);
  });
});
