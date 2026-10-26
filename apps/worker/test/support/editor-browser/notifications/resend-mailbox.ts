import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  RESEND_API_ENDPOINT,
  SecureHttpClient,
  createResendClient,
  type SecureHttpTransportRequest,
  type SecureHttpTransportResponse,
} from '@pertexo/integrations/server';

const publicTestAddress = '8.8.8.8';
const maximumBytes = 10_485_760;
const maximumTextBytes = 4_096;

const messageSchema = z
  .object({
    from: z.string(),
    to: z.array(z.string()).length(1),
    subject: z.string(),
    text: z.string(),
    attachments: z
      .array(
        z
          .object({
            filename: z.string(),
            content_type: z.string(),
            content: z.string(),
          })
          .strict(),
      )
      .max(10)
      .optional(),
  })
  .strict();

export type DeliveredEmail = Readonly<{
  to: string;
  subject: string;
  attachments: readonly Readonly<{
    filename: string;
    contentType: string;
    byteLength: number;
    sha256: string;
    /** Small text files only, so the journey can read what arrived. */
    text?: string;
  }>[];
}>;

async function requestBytes(
  body: NonNullable<SecureHttpTransportRequest['body']>,
): Promise<Buffer> {
  if (body instanceof Uint8Array) return Buffer.from(body);
  if (body.byteLength > maximumBytes) throw new Error('Owned body too large');
  const chunks: Buffer[] = [];
  for await (const chunk of body.open(new AbortController().signal))
    chunks.push(Buffer.from(chunk as Uint8Array));
  return Buffer.concat(chunks);
}

function delivered(bytes: Buffer): DeliveredEmail {
  const message = messageSchema.parse(JSON.parse(bytes.toString('utf8')));
  return Object.freeze({
    to: message.to[0] ?? '',
    subject: message.subject,
    attachments: (message.attachments ?? []).map((attachment) => {
      const content = Buffer.from(attachment.content, 'base64');
      return Object.freeze({
        filename: attachment.filename,
        contentType: attachment.content_type,
        byteLength: content.byteLength,
        sha256: createHash('sha256').update(content).digest('hex'),
        ...(content.byteLength <= maximumTextBytes
          ? { text: content.toString('utf8') }
          : {}),
      });
    }),
  });
}

/**
 * Stands in for Resend with the real secure client and executor: it accepts
 * each email and keeps what arrived, so the journey reads the delivered
 * message the way the notifications journey reads its SMTP sink.
 */
export function createEditorResendMailbox(
  onDelivery: (emails: readonly DeliveredEmail[]) => void,
) {
  const emails: DeliveredEmail[] = [];
  let closed = false;
  const dispatch = async (
    input: SecureHttpTransportRequest,
  ): Promise<SecureHttpTransportResponse> => {
    if (
      closed ||
      input.url.href !== RESEND_API_ENDPOINT ||
      input.method !== 'POST' ||
      input.address.address !== publicTestAddress ||
      input.body === undefined ||
      input.signal?.aborted === true
    )
      throw new Error('Outside the owned Resend fixture');
    emails.push(delivered(await requestBytes(input.body)));
    onDelivery([...emails]);
    const response = Buffer.from(JSON.stringify({ id: randomUUID() }));
    return {
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: (async function* () {
        await Promise.resolve();
        yield response;
      })(),
      close: () => {
        response.fill(0);
      },
    };
  };
  const httpClient = new SecureHttpClient(
    {
      resolve: (hostname) =>
        !closed && hostname === new URL(RESEND_API_ENDPOINT).hostname
          ? Promise.resolve([{ address: publicTestAddress, family: 4 }])
          : Promise.reject(new Error('Outside the owned Resend DNS')),
    },
    { dispatch },
  );
  return {
    httpClient,
    client: createResendClient(httpClient),
    observe: () => [...emails],
    close: () => {
      closed = true;
      return Promise.resolve();
    },
  };
}
