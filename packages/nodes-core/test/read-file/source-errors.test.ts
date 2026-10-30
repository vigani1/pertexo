import { FILE_PAGE_LIMITS } from '@pertexo/node-sdk';
import { encodeFilePageRecord } from '@pertexo/node-sdk/server';
import { describe, expect, it } from 'vitest';

import { readCsvRecords } from '../../src/data/read-file/csv/records.js';
import { readJsonRecords } from '../../src/data/read-file/json/records.js';

// A failure while reading the stored file is not a fault in its contents: the
// readers pass it on unchanged instead of blaming the file's format.
const readFailure = new Error('read ECONNRESET');
const signal = new AbortController().signal;

async function* failsAfter(text: string) {
  yield await Promise.resolve(Buffer.from(text));
  throw readFailure;
}

async function drain(records: AsyncIterable<unknown>) {
  for await (const _record of records) {
    /* Read until the source fails. */
  }
}

describe('file readers and source failures', () => {
  it('passes a JSON source failure through unchanged', async () => {
    await expect(
      drain(readJsonRecords(failsAfter('[{"name":"Ada"},'), signal)),
    ).rejects.toBe(readFailure);
  });

  it('passes a CSV source failure through unchanged', async () => {
    await expect(
      drain(
        readCsvRecords(
          failsAfter('name\nAda\n'),
          { format: 'csv', delimiter: ',', convertValues: true },
          signal,
          {
            maxRecordSize: FILE_PAGE_LIMITS.bytes,
            accept: encodeFilePageRecord,
          },
        ),
      ),
    ).rejects.toBe(readFailure);
  });
});
