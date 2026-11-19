// What the outside sender runs for each request: a plain Node HTTP(S) client
// that trusts only the public roots it was given. It can sign a webhook body,
// size it exactly, and trickle it out slowly, as real senders sometimes do.
// It prints one JSON line: the response, or the network error it met.
export const OUTSIDE_REQUEST = String.raw`
import { request as secure } from 'node:https';
import { request as plain } from 'node:http';
import { createHmac } from 'node:crypto';

const input = JSON.parse(process.env.SENDER_INPUT);
const started = Date.now();
const headers = { ...input.headers };
let body = input.body === undefined ? undefined : Buffer.from(input.body, 'base64');
if (input.webhook) {
  const { signingSecret, bytes, eventId } = input.webhook;
  const prefix = '{"eventId":"' + eventId + '","padding":"';
  const suffix = '"}';
  const padding = Math.max(0, bytes - prefix.length - suffix.length);
  body = Buffer.from(prefix + 'x'.repeat(padding) + suffix);
  const timestamp = String(Math.floor(Date.now() / 1000));
  headers['content-type'] = 'application/json';
  headers['x-pertexo-timestamp'] = timestamp;
  headers['x-pertexo-signature'] =
    'v1=' +
    createHmac('sha256', Buffer.from(signingSecret, 'base64url'))
      .update(timestamp + '.')
      .update(body)
      .digest('hex');
}
if (body !== undefined) headers['content-length'] = String(body.length);

const url = new URL(input.url);
const send = url.protocol === 'https:' ? secure : plain;
const result = await new Promise((resolve) => {
  const sent = send(
    url,
    { method: input.method ?? 'GET', headers, agent: false },
    (response) => {
      const certificate = describe(response.socket);
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('error', (error) => resolve({ error: error.code ?? error.message }));
      response.on('end', () =>
        resolve({
          status: response.statusCode,
          headers: response.headers,
          text: Buffer.concat(chunks).toString().slice(0, 4000),
          certificate,
        }),
      );
    },
  );
  sent.setTimeout(input.timeout ?? 120000, () => sent.destroy(new Error('client timeout')));
  sent.on('error', (error) => resolve({ error: error.code ?? 'ERROR', message: error.message }));
  if (body === undefined) return sent.end();
  const pieces = input.pieces ?? 1;
  const size = Math.ceil(body.length / pieces);
  let index = 0;
  const next = () => {
    const piece = body.subarray(index * size, (index + 1) * size);
    index += 1;
    if (index >= pieces) return sent.end(piece);
    sent.write(piece);
    setTimeout(next, input.pauseMillis ?? 0);
  };
  next();
});
console.log(JSON.stringify({ ...result, millis: Date.now() - started }));

function describe(socket) {
  if (typeof socket?.getPeerCertificate !== 'function') return undefined;
  const certificate = socket.getPeerCertificate();
  return {
    subjectaltname: certificate.subjectaltname,
    issuer: certificate.issuer?.CN,
    validFrom: certificate.valid_from,
    validTo: certificate.valid_to,
    serial: certificate.serialNumber,
  };
}
`;
