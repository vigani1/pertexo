import { spawnSync } from 'node:child_process';
import { expect, it } from 'vitest';

function probe(total: number) {
  const parser = new URL(
    '../../dist/data/read-file/csv/records.js',
    import.meta.url,
  ).href;
  const sdk = new URL('../../../node-sdk/dist/server.js', import.meta.url).href;
  const script = `
  import {createHash,randomUUID} from 'node:crypto';
  const {readCsvRecords}=await import(${JSON.stringify(parser)});
  const {encodeFilePageRecord,writeFilePages}=await import(${JSON.stringify(sdk)});
  let high=process.memoryUsage(),bytes=0;
  const sample=()=>{const current=process.memoryUsage();for(const key of Object.keys(current))high[key]=Math.max(high[key],current[key]);};
  async function* source(){yield Buffer.from('id,text,currency\\r\\n');for(let id=0;id<${String(total)};id++){if(id%1000===0)sample();yield Buffer.from(id+','+'a'.repeat(50)+',EUR\\r\\n');}}
  const signal=new AbortController().signal;
  const output=await writeFilePages(readCsvRecords(source(),{format:'csv',delimiter:',',convertValues:true},signal,{maxRecordSize:65536,accept:encodeFilePageRecord}),{write:async input=>{
   let size=0;const hash=createHash('sha256');for await(const chunk of input.body){size+=chunk.length;hash.update(chunk);}bytes+=size;sample();return {artifactId:randomUUID(),byteLength:size,mediaType:input.mediaType,sha256:hash.digest('hex')};
  }},signal);sample();console.log(JSON.stringify({count:output.itemCount,pages:output.pageCount,bytes,high}));
 `;
  const result = spawnSync(
    process.execPath,
    ['--max-old-space-size=64', '--input-type=module', '--eval', script],
    { encoding: 'utf8', timeout: 30000, maxBuffer: 65536 },
  );
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout) as {
    count: number;
    pages: number;
    bytes: number;
    high: { rss: number; heapUsed: number; external: number };
  };
}
it('keeps maximum CSV paging within a 64 MB heap without retaining all records', () => {
  const baseline = probe(10000),
    maximum = probe(100000);
  expect(baseline.count).toBe(10000);
  expect(maximum.count).toBe(100000);
  expect(maximum.bytes).toBeLessThanOrEqual(10485760);
  expect(maximum.pages).toBeLessThanOrEqual(256);
  expect(maximum.high.heapUsed).toBeLessThan(64 * 1024 * 1024);
  expect(maximum.high.external).toBeLessThan(16 * 1024 * 1024);
  process.stdout.write(
    'F45 CSV pages: ' + JSON.stringify({ baseline, maximum }) + '\n',
  );
}, 60000);
