import assert from 'node:assert/strict';
import { connect } from 'node:net';
import {
  readCodeFrame,
  writeCodeFrame,
} from '/workspace/packages/node-sdk/dist/server.js';

const socket = connect('/run/pertexo-code/runner.sock');
const disconnected = new AbortController();
socket.on('error', () => {
  disconnected.abort();
});
socket.on('close', () => {
  disconnected.abort();
});
const signal = AbortSignal.any([
  disconnected.signal,
  AbortSignal.timeout(15_000),
]);
try {
  const greeting = await readCodeFrame(socket, 16 * 1024, signal);
  assert.equal(greeting.kind, 'ready');
  assert.equal(greeting.mode, 'hardened');
  await writeCodeFrame(socket, {
    code: 'while(true) {}',
    timeoutSeconds: 10,
    input: null,
    variables: {},
  });
  console.log('Code task submitted.');
  await assert.rejects(readCodeFrame(socket, 2 * 1048576, signal));
  console.log('In-flight task lost its manager and closed its transport.');
} finally {
  socket.destroy();
}
