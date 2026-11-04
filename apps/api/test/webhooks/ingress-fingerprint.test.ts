import { expect, it } from 'vitest';
import { webhookRequestFingerprint } from '../../src/webhooks/ingress/fingerprint.js';

it.each(
  [
    [
      'POST',
      '{"a":1}',
      'application/json',
      '',
      '0e0c75e6e71ce29bf743594e3360276e9b5102068fd340ed8d9c7d790284ade8',
    ],
    [
      'POST',
      '{"a":1}',
      'application/json',
      'x=1',
      'c9ccb9a64ec2f61afa3febd9ac61f44df5eaa77182fadaf718326a38b85093ae',
    ],
    [
      'POST',
      '{"a":2}',
      'application/json',
      '',
      'bf492e26743aaedb4d35afcd0eb48efe1a55fbe6a330f2ac323da7988708df35',
    ],
    [
      'POST',
      '{"a":1}',
      'text/plain',
      '',
      'b1c87ec0fce192adc531ff7e8fca45c5da6fe76a21aa81af6d24ecd1fe2ea2c3',
    ],
    [
      'GET',
      '',
      '',
      'x=1',
      'db990e5dd3988da6e8e5ec69c676311eceaef5e1f95ee2f8cd17cf3cf0bc5d1e',
    ],
  ].map(([method, body, mediaType, query, expected]) => ({
    method,
    body,
    mediaType,
    query,
    expected,
  })),
)(
  'preserves the stored replay identity for $method $body $mediaType $query',
  ({ method, body, mediaType, query, expected }) => {
    expect(
      webhookRequestFingerprint({
        endpointId: '11111111-1111-4111-8111-111111111111',
        method,
        body: Buffer.from(body),
        mediaType,
        query,
      }),
    ).toBe(expected);
  },
);
