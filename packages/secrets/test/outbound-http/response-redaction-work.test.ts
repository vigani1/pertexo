import { boundedRedactedBody } from '../../src/outbound-http/stream-redaction.js';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { expect, it } from 'vitest';

// A separate process uses the shipped worker heap and cannot hide synchronous
// scanner work behind an in-process timeout or a larger test-runner heap.
it.each([1, 32, 64])(
  'bounds four-layer masking at the response size limit with %i credentials',
  async (count) => {
    const script = `
    import { boundedRedactedBody } from ${JSON.stringify(new URL('../../dist/outbound-http/stream-redaction.js', import.meta.url).href)};
    let source='"'+String.raw\`\\u0061\`.repeat(Math.floor((10485760-100)/13))+'"';
    for(let layer=1;layer<4;layer++) source=JSON.stringify(source);
    const body=Buffer.from(source), retained=[];
    const sensitiveValues=Array.from({length:${String(count)}},(_,index)=>index===0?'a'.repeat(7990)+'b':'credential-'+index+'-private');
    const started=performance.now();
    let code;
    try {
      for await (const chunk of boundedRedactedBody((async function*(){for(let at=0;at<body.length;at+=65536)yield Buffer.from(body.subarray(at,at+65536));})(),{
        limit:10485760, sensitiveValues, signal:new AbortController().signal, deadline:started+60000,
      })) retained.push(Buffer.from(chunk));
    } catch (error) { code=error.code; }
    console.log(JSON.stringify({ code, elapsedMs:performance.now()-started, sourceBytes:body.length, retainedBytes:Buffer.concat(retained).length }));
  `;
    const child = spawn(
      process.execPath,
      ['--max-old-space-size=384', '--input-type=module', '-e', script],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    const output: Buffer[] = [],
      errors: Buffer[] = [];
    child.stdout.on('data', (part: Buffer) => output.push(part));
    child.stderr.on('data', (part: Buffer) => errors.push(part));
    const closed: readonly unknown[] = await once(child, 'close');
    expect(closed[0], Buffer.concat(errors).toString()).toBe(0);
    const result: unknown = JSON.parse(Buffer.concat(output).toString());
    expect(result).toMatchObject({
      code: 'response_redaction_limit',
      sourceBytes: 10_485_687,
    });
    expect(result).toHaveProperty('elapsedMs', expect.any(Number));
    if (typeof result !== 'object' || result === null)
      throw new Error('Missing measurement');
    expect(Reflect.get(result, 'elapsedMs')).toBeLessThan(1_000);
    expect(Reflect.get(result, 'retainedBytes')).toBeLessThan(10_485_687);
    console.info('NESTED_REDACTION=' + JSON.stringify(result));
  },
  60_000,
);

it('refuses cumulative decoding work across ordinary chunks, even when each chunk is cheap', async () => {
  const source = Buffer.from(String.raw`\u0061`.repeat(350_000));
  let retained = 0;
  const consume = async () => {
    for await (const chunk of boundedRedactedBody(
      (async function* () {
        await Promise.resolve();
        for (let offset = 0; offset < source.length; offset += 65_536)
          yield Buffer.from(source.subarray(offset, offset + 65_536));
      })(),
      {
        limit: source.length,
        sensitiveValues: ['private'],
        signal: new AbortController().signal,
        deadline: performance.now() + 10_000,
      },
    ))
      retained += chunk.length;
  };
  await expect(consume()).rejects.toMatchObject({
    code: 'response_redaction_limit',
  });
  expect(retained).toBeLessThan(source.length);
});
