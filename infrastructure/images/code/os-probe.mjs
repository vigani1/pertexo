import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';

// Deliberately omit Node permissions and module restrictions. These checks
// prove the inherited kernel/identity fences independently of the JS policy.
writeFileSync('/tmp/manager-private', 'manager-only', { mode: 0o600 });
const other = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {
  uid: 20014,
  gid: 20014,
  stdio: 'ignore',
  env: { OTHER_RUN_VALUE: 'private other-run data' },
});
const source = `
const fs=require('fs'),cp=require('child_process');
const result={};
const checks={
 managerEnvironment:()=>fs.readFileSync('/proc/1/environ'),
 managerMemory:()=>fs.readFileSync('/proc/1/mem'),
 managerDescriptors:()=>fs.readdirSync('/proc/1/fd'),
 managerPrivate:()=>fs.readFileSync('/tmp/manager-private'),
 otherRun:()=>fs.readFileSync('/proc/${other.pid}/environ'),
 protocolDirectory:()=>fs.readdirSync('/run/pertexo-code'),
 managerSignal:()=>process.kill(1,0),
 diskWrite:()=>fs.writeFileSync('/tmp/escape','bad'),
 sharedMemoryWrite:()=>fs.writeFileSync('/dev/shm/escape','bad'),
 lowerOomPriority:()=>fs.writeFileSync('/proc/self/oom_score_adj','-1000'),
};
for(const [name,operation] of Object.entries(checks)) {try{operation();result[name]='ALLOWED'}catch(error){result[name]=error.code}}
result.fork=cp.spawnSync('/bin/true').error?.code??'ALLOWED';
result.status=fs.readFileSync('/proc/self/status','utf8');
result.oom=fs.readFileSync('/proc/self/oom_score_adj','utf8').trim();
(async()=>{
 for(const [name,options] of Object.entries({postgres:{host:'127.0.0.1',port:5432},redis:{host:'127.0.0.1',port:6379},internet:{host:'1.1.1.1',port:443},managerSocket:{path:'/run/pertexo-code/runner.sock'},abstractSocket:{path:'\\0pertexo-code'}})) {
  result[name]=await new Promise(resolve=>{const socket=require('net').connect(options);socket.on('error',error=>{socket.destroy();resolve(error.code)});socket.on('connect',()=>{socket.destroy();resolve('ALLOWED')})});
 }
 console.log(JSON.stringify(result));
})();
`;
const probe = spawnSync(
  '/workspace/apps/code-runner/dist/launch',
  [
    '20015',
    '128',
    '10',
    process.execPath,
    '--max-old-space-size=128',
    '--disable-wasm-trap-handler',
    '--no-experimental-strip-types',
    '-e',
    source,
  ],
  {
    encoding: 'utf8',
    timeout: 15_000,
    env: { PATH: '/usr/local/bin:/usr/bin:/bin', UV_THREADPOOL_SIZE: '1' },
  },
);
other.kill('SIGKILL');
assert.equal(probe.status, 0, probe.stderr);
const result = JSON.parse(probe.stdout);
for (const name of [
  'managerEnvironment',
  'managerMemory',
  'managerDescriptors',
  'managerPrivate',
  'otherRun',
  'protocolDirectory',
])
  assert.equal(result[name], 'EACCES', name);
assert.equal(result.managerSignal, 'EPERM');
for (const name of [
  'diskWrite',
  'sharedMemoryWrite',
  'lowerOomPriority',
  'fork',
  'postgres',
  'redis',
  'internet',
  'managerSocket',
  'abstractSocket',
])
  assert.equal(result[name], 'ENOSYS', name);
assert.match(result.status, /^Uid:\s*20015\s+20015\s+20015\s+20015$/mu);
assert.match(result.status, /^Gid:\s*20015\s+20015\s+20015\s+20015$/mu);
assert.match(result.status, /^Groups:\s*$/mu);
assert.match(result.status, /^CapEff:\s*0+$/mu);
assert.match(result.status, /^NoNewPrivs:\s*1$/mu);
assert.match(result.status, /^Seccomp:\s*2$/mu);
assert.equal(result.oom, '1000');
console.log(
  'Kernel fences independently refused manager/other-run reads, protocol access, writes, forks, signals and all network destinations.',
);
