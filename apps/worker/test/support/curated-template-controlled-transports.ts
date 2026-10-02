import { createHash, timingSafeEqual } from 'node:crypto';
import {
  SecureHttpClient,
  createSlackClient,
  SLACK_API_ENDPOINTS,
  type SecureHttpTransportRequest,
  type SecureHttpTransportResponse,
} from '@pertexo/integrations/server';
import { CURATED_TEMPLATE_FIXTURE } from '../../../../infrastructure/testing/curated-template-envelope-context.mjs';

type Observation = Readonly<{
  kind: 'http' | 'slack';
  status: number;
  bodyHash: string;
}>;
const publicTestAddress = '8.8.8.8';
const maximumBytes = 4096;

/** The live nine-case qualification must include the real synthetic 5xx witness.
 * An exhausted shorter response plan also yields an unsafe unknown outcome,
 * but is not evidence that a 500 response was actually returned.
 */
export function createCuratedTemplateQualificationTransports() {
  return createCuratedTemplateControlledTransports([200, 204, 500]);
}

/** No sockets, DNS fallback or provider networking. The actual secure clients,
 * executor registrations, authority callback and worker engine remain in use.
 */
export function createCuratedTemplateControlledTransports(
  statuses: readonly number[] = [200, 204, 500],
) {
  if (
    statuses.length === 0 ||
    statuses.length > 16 ||
    statuses.some(
      (status) => status !== 200 && status !== 204 && status !== 500,
    )
  )
    throw new Error('Owned curated HTTP response plan invalid');
  const pendingStatuses = [...statuses];
  const observations: Observation[] = [];
  let closed = false;
  const matches = (supplied: string | undefined, expected: string) => {
    const left = Buffer.from(supplied ?? '');
    const right = Buffer.from(expected);
    try {
      return left.length === right.length && timingSafeEqual(left, right);
    } finally {
      left.fill(0);
      right.fill(0);
    }
  };
  const dispatch = (
    input: SecureHttpTransportRequest,
  ): Promise<SecureHttpTransportResponse> => {
    try {
      if (
        closed ||
        observations.length >= 32 ||
        input.signal?.aborted === true ||
        input.address.address !== publicTestAddress ||
        input.address.family !== 4 ||
        input.timeoutMillis !== 1000 ||
        (input.body?.byteLength ?? 0) > maximumBytes
      )
        throw new Error('rejected');
      let status: number;
      let kind: Observation['kind'];
      let responseBody: Uint8Array;
      if (input.url.href === CURATED_TEMPLATE_FIXTURE.httpEndpoint) {
        if (
          input.method !== 'GET' ||
          input.body !== undefined ||
          Object.keys(input.headers).join(',') !== 'authorization' ||
          !matches(
            input.headers.authorization,
            CURATED_TEMPLATE_FIXTURE.httpAuthorization,
          )
        )
          throw new Error('rejected');
        const next = pendingStatuses.shift();
        if (next === undefined) throw new Error('rejected');
        status = next;
        kind = 'http';
        responseBody = Buffer.from(next === 200 ? '{"accepted":true}' : '');
      } else if (input.url.href === SLACK_API_ENDPOINTS.sendMessage) {
        if (
          input.method !== 'POST' ||
          input.body === undefined ||
          Object.keys(input.headers).sort().join(',') !==
            'accept,authorization,content-type' ||
          input.headers.accept !== 'application/json' ||
          input.headers['content-type'] !== 'application/json; charset=utf-8' ||
          !matches(
            input.headers.authorization,
            `Bearer ${CURATED_TEMPLATE_FIXTURE.slackBotToken}`,
          )
        )
          throw new Error('rejected');
        const body: unknown = JSON.parse(
          new TextDecoder('utf-8', { fatal: true }).decode(input.body),
        );
        if (
          typeof body !== 'object' ||
          body === null ||
          Object.keys(body).sort().join(',') !==
            'channel,text,unfurl_links,unfurl_media' ||
          !('channel' in body) ||
          body.channel !== CURATED_TEMPLATE_FIXTURE.slackChannel ||
          !('text' in body) ||
          body.text !== CURATED_TEMPLATE_FIXTURE.slackText ||
          !('unfurl_links' in body) ||
          body.unfurl_links !== false ||
          !('unfurl_media' in body) ||
          body.unfurl_media !== false
        )
          throw new Error('rejected');
        status = 200;
        kind = 'slack';
        responseBody = Buffer.from(
          JSON.stringify({
            ok: true,
            channel: CURATED_TEMPLATE_FIXTURE.slackChannel,
            ts: '1700000000.000001',
          }),
        );
      } else throw new Error('rejected');
      observations.push(
        Object.freeze({
          kind,
          status,
          bodyHash: createHash('sha256')
            .update(input.body ?? new Uint8Array())
            .digest('hex'),
        }),
      );
      let responseClosed = false;
      const close = () => {
        responseClosed = true;
        responseBody.fill(0);
      };
      const unavailable = () => closed || responseClosed;
      return Promise.resolve({
        status,
        headers: { 'content-type': 'application/json' },
        body: (async function* () {
          try {
            await Promise.resolve();
            if (unavailable() || input.signal?.aborted === true)
              throw new Error('Owned curated response disposed');
            yield responseBody;
          } finally {
            close();
          }
        })(),
        close,
      });
    } catch {
      return Promise.reject(new Error('Owned curated dispatch rejected'));
    }
  };
  const httpClient = new SecureHttpClient(
    {
      resolve: (hostname) =>
        !closed &&
        [
          new URL(CURATED_TEMPLATE_FIXTURE.httpEndpoint).hostname,
          'slack.com',
        ].includes(hostname)
          ? Promise.resolve([
              { address: publicTestAddress, family: 4 as const },
            ])
          : Promise.reject(new Error('Owned curated hostname rejected')),
    },
    { dispatch },
  );
  return {
    httpClient,
    slackClient: createSlackClient(httpClient),
    transport: { dispatch },
    observe: () => ({
      observations: [...observations],
      pendingHttpResponses: pendingStatuses.length,
    }),
    close: () => {
      closed = true;
      return Promise.resolve();
    },
  };
}
