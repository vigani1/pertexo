import { readFile } from 'node:fs/promises';
import { must, mustDocker } from '../support/process.mjs';

// A Node service's own view of its memory (RSS, V8 heap, external and array
// buffers), read from outside without changing the product: the runner opens
// the process's inspector with SIGUSR1, then asks it for process.memoryUsage()
// from inside the container's network namespace, where the inspector listens on
// loopback only. The client runs as the runner's node, so the container's
// memory never includes it. Needs Linux, root through sudo, and Docker.

const MIB = 1024 * 1024;
const INSPECTOR_PORT = 9229;
const opened = new Set();

// Runs in the container's network namespace; its only output is the JSON.
const CLIENT = `
const address = 'http://127.0.0.1:${INSPECTOR_PORT}/json/list';
let targets;
for (let attempt = 0; !targets; attempt++) {
  try { targets = await (await fetch(address)).json(); }
  catch (error) { if (attempt === 20) throw error; await new Promise((r) => setTimeout(r, 250)); }
}
const socket = new WebSocket(targets[0].webSocketDebuggerUrl);
await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
const answer = new Promise((resolve) => { socket.onmessage = (event) => {
  const message = JSON.parse(event.data);
  if (message.id === 1) resolve(message);
}; });
socket.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: {
  expression: 'JSON.stringify(process.memoryUsage())', returnByValue: true } }));
const reply = await answer;
socket.close();
process.stdout.write(reply.result.result.value);
`;

/**
 * The service's Node process memory in MiB, and what lies outside V8's heap and
 * external buffers: native allocations, malloc arenas, code and stacks.
 */
export async function nodeProcessMemory(server, service) {
  const pid = await nodePid(await server.containerOf(service));
  if (!opened.has(pid)) {
    await must('sudo', ['kill', '-USR1', String(pid)]);
    opened.add(pid);
  }
  const usage = JSON.parse(
    await must(
      'sudo',
      [
        'nsenter',
        '--target',
        String(pid),
        '--net',
        process.execPath,
        '--input-type=module',
        '--eval',
        CLIENT,
      ],
      { timeout: 30_000 },
    ),
  );
  const status = await readFile(`/proc/${pid}/status`, 'utf8');
  const threads = Number(/^Threads:\s+(\d+)/mu.exec(status)?.[1]);
  const mib = (value) => Math.round((value / MIB) * 10) / 10;
  return {
    pid,
    threads,
    rssMib: mib(usage.rss),
    heapUsedMib: mib(usage.heapUsed),
    heapTotalMib: mib(usage.heapTotal),
    externalMib: mib(usage.external),
    arrayBuffersMib: mib(usage.arrayBuffers),
    outsideHeapMib: mib(usage.rss - usage.heapTotal - usage.external),
  };
}

/**
 * The service's own Node process as the host sees it. Node names its main
 * thread, so `comm` won't do, and the Code runner's sandboxes run node too:
 * the service is the process running its built entry point.
 */
async function nodePid(container) {
  const listed = await mustDocker(['top', container, '-eo', 'pid,args']);
  const row = listed
    .split('\n')
    .map((line) =>
      /^\s*(\d+)\s+node\s+apps\/[\w-]+\/dist\/main\.js$/u.exec(line),
    )
    .find(Boolean);
  if (!row)
    throw new Error(`no service node process in ${container}:\n${listed}`);
  return Number(row[1]);
}

/** The memory limit Docker enforces on the service's container, in MiB. */
export async function containerLimitMib(server, service) {
  const bytes = Number(
    await mustDocker([
      'inspect',
      '--format',
      '{{.HostConfig.Memory}}',
      await server.containerOf(service),
    ]),
  );
  return bytes > 0 ? bytes / MIB : null;
}
