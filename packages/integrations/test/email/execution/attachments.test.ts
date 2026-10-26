import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  FileInputFailure,
  type NodeArtifactRuntime,
  type NodeExecutionRuntime,
} from '@pertexo/node-sdk/server';
import {
  createEmailSendNotificationExecutorRegistration,
  createResendClient,
  type SecureHttpRequest,
} from '../../../src/server.js';
import {
  sourceBytes,
  spoolBytes,
  verifiedSource,
} from '../../support/artifact-runtime.js';
import {
  invocation,
  originalBinding,
  runtime,
} from '../../support/email-execution.js';

const emailId = '49b9a1e5-3f0c-4e68-882d-fbc91c0d4ec2';
const csv = new TextEncoder().encode('currency,amount\r\nEUR,20\r\nUSD,9\r\n');
const pdf = Uint8Array.from({ length: 70_001 }, (_, index) => index % 251);

function stored(bytes: Uint8Array, mediaType: string) {
  return {
    kind: 'artifact' as const,
    artifactId: crypto.randomUUID(),
    byteLength: bytes.byteLength,
    mediaType,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  };
}

const report = stored(csv, 'text/csv');
const terms = stored(pdf, 'application/pdf');

/** The workspace's files; anything else is unavailable, as for a foreign file. */
function artifacts(
  files: ReadonlyMap<string, Uint8Array>,
): NodeArtifactRuntime & { opened: string[] } {
  const opened: string[] = [];
  return {
    opened,
    openVerified: ({ reference }) => {
      opened.push(reference.artifactId);
      const bytes = files.get(reference.artifactId);
      if (bytes === undefined)
        return Promise.reject(
          new FileInputFailure({ reason: 'file_unavailable' }),
        );
      return Promise.resolve(verifiedSource(Uint8Array.from(bytes)));
    },
    spool: spoolBytes,
    write: () => Promise.reject(new Error('No artifact writes expected')),
  };
}

function resend() {
  const bodies: Buffer[] = [];
  const execute = vi.fn(async (request: SecureHttpRequest) => {
    if (request.body === undefined) throw new Error('Expected a body');
    bodies.push(await sourceBytes(request.body));
    await request.beforeDispatch();
    return {
      status: 200,
      headers: {},
      body: new TextEncoder().encode(JSON.stringify({ id: emailId })),
      bodyEncoding: 'utf8' as const,
      finalUrl: request.url,
      redirectCount: 0,
    };
  });
  return { execute, bodies, client: createResendClient({ execute }) };
}

function withFiles(
  value: NodeExecutionRuntime,
  files: NodeArtifactRuntime,
): NodeExecutionRuntime {
  return Object.freeze({ ...value, artifacts: files });
}

function send(
  attachments: unknown,
  files = artifacts(
    new Map([
      [report.artifactId, csv],
      [terms.artifactId, pdf],
    ]),
  ),
  state = runtime({ kind: 'succeeded', emailId }),
) {
  const provider = resend();
  const call = invocation(withFiles(state.value, files));
  const result = createEmailSendNotificationExecutorRegistration({
    client: provider.client,
  }).execute({ ...call, input: { ...call.input, attachments } });
  return { result, provider, files, state };
}

describe('email.send_notification@1 attachments', () => {
  it('sends each file as base64 with its name and stored content type', async () => {
    const { result, provider } = send([
      { file: report, filename: 'weekly/report.csv' },
      { file: terms },
    ]);
    await expect(result).resolves.toEqual({
      emailId,
      attachments: [
        {
          filename: 'weeklyreport.csv',
          mediaType: 'text/csv',
          byteLength: csv.byteLength,
        },
        {
          filename: 'attachment-2.pdf',
          mediaType: 'application/pdf',
          byteLength: pdf.byteLength,
        },
      ],
    });
    expect(provider.execute).toHaveBeenCalledOnce();
    const body = JSON.parse(provider.bodies[0]?.toString('utf8') ?? '') as {
      attachments: {
        filename: string;
        content_type: string;
        content: string;
      }[];
    };
    expect(body).toMatchObject({
      to: ['Recipient@example.com'],
      subject: 'Deployment complete',
      text: 'Production is healthy.',
    });
    expect(
      body.attachments.map(({ filename, content_type }) => ({
        filename,
        content_type,
      })),
    ).toEqual([
      { filename: 'weeklyreport.csv', content_type: 'text/csv' },
      { filename: 'attachment-2.pdf', content_type: 'application/pdf' },
    ]);
    expect(
      Buffer.from(body.attachments[0]?.content ?? '', 'base64').equals(
        Buffer.from(csv),
      ),
    ).toBe(true);
    expect(
      Buffer.from(body.attachments[1]?.content ?? '', 'base64').equals(
        Buffer.from(pdf),
      ),
    ).toBe(true);
  });

  it('sends a byte-identical request for the same files and a different one for a changed file', async () => {
    const attachments = [{ file: report }, { file: terms, filename: 'T.pdf' }];
    const first = send(attachments);
    const second = send(attachments);
    await Promise.all([first.result, second.result]);
    expect(
      first.provider.bodies[0]?.equals(
        second.provider.bodies[0] ?? Buffer.alloc(0),
      ),
    ).toBe(true);
    const edited = new TextEncoder().encode('currency,amount\r\nEUR,21\r\n');
    const revised = stored(edited, 'text/csv');
    const changed = send(
      [{ file: revised }, { file: terms, filename: 'T.pdf' }],
      artifacts(
        new Map([
          [revised.artifactId, edited],
          [terms.artifactId, pdf],
        ]),
      ),
    );
    await changed.result;
    expect(
      changed.provider.bodies[0]?.equals(
        first.provider.bodies[0] ?? Buffer.alloc(0),
      ),
    ).toBe(false);
  });

  it('fails a missing or foreign file before the connection or provider is used', async () => {
    const foreign = stored(new Uint8Array([1, 2, 3]), 'text/plain');
    const { result, provider, state } = send([
      { file: report },
      { file: foreign },
    ]);
    await expect(result).rejects.toMatchObject({
      kind: 'failed',
      errorKind: 'configuration',
      safeErrorCode: 'execution.file_input',
      possiblyDispatched: false,
    });
    expect(provider.execute).not.toHaveBeenCalled();
    expect(state.beforeDispatch).not.toHaveBeenCalled();
    expect(state.assertCurrent).not.toHaveBeenCalled();
  });

  it('refuses too many or too large attachments before reading any file', async () => {
    const tooMany = send(Array.from({ length: 11 }, () => ({ file: report })));
    await expect(tooMany.result).rejects.toMatchObject({
      safeErrorCode: 'email.too_many_attachments',
      possiblyDispatched: false,
    });
    expect(tooMany.files.opened).toEqual([]);
    const tooLarge = send([
      { file: { ...report, byteLength: 6 * 1_048_576 + 1 } },
    ]);
    await expect(tooLarge.result).rejects.toMatchObject({
      safeErrorCode: 'email.attachments_too_large',
      possiblyDispatched: false,
    });
    expect(tooLarge.files.opened).toEqual([]);
    expect(tooLarge.provider.execute).not.toHaveBeenCalled();
  });

  it('keeps an earlier unresolved dispatch unknown when a file can no longer be read', async () => {
    const { result, provider } = send(
      [{ file: report }],
      artifacts(new Map()),
      runtime({ kind: 'succeeded', emailId }, undefined, originalBinding, true),
    );
    await expect(result).rejects.toMatchObject({
      kind: 'outcome_unknown',
      possiblyDispatched: true,
    });
    expect(provider.execute).not.toHaveBeenCalled();
  });

  it('releases every opened file and the spooled body', async () => {
    const releases: string[] = [];
    const files = artifacts(
      new Map([
        [report.artifactId, csv],
        [terms.artifactId, pdf],
      ]),
    );
    const tracked: NodeArtifactRuntime = {
      ...files,
      openVerified: async (request) => {
        const source = await files.openVerified?.(request);
        if (source === undefined) throw new Error('Expected a source');
        return {
          ...source,
          open: (signal) => source.open(signal),
          release: () => {
            releases.push(request.reference.artifactId);
            return source.release();
          },
        };
      },
      spool: async (request) => {
        const body = await spoolBytes(request);
        return {
          ...body,
          open: (signal) => body.open(signal),
          release: () => {
            releases.push('body');
            return body.release();
          },
        };
      },
    };
    const { result } = send([{ file: report }, { file: terms }], {
      ...tracked,
      opened: [],
    });
    await result;
    expect(releases.sort()).toEqual(
      ['body', report.artifactId, terms.artifactId].sort(),
    );
  });

  it('sends exactly the old request when attachments are absent or empty', async () => {
    const { result, provider } = send([]);
    await expect(result).resolves.toEqual({ emailId });
    expect(
      Object.keys(
        JSON.parse(provider.bodies[0]?.toString('utf8') ?? '{}') as object,
      ),
    ).toEqual(['from', 'to', 'subject', 'text']);
  });
});
