import { awaitWithSignal } from '../src/artifact-request-lifecycle.js';

const unhandled: unknown[] = [];
process.on('unhandledRejection', (reason: unknown) => {
  unhandled.push(reason);
});

const controller = new AbortController();
const abortReason = new Error('already cancelled');
controller.abort(abortReason);
let rejectOperation: ((reason: unknown) => void) | undefined;
const operation = new Promise<never>((_resolve, reject) => {
  rejectOperation = reject;
});
const result = awaitWithSignal(operation, controller.signal);
let caught: unknown;
try {
  await result;
} catch (error: unknown) {
  caught = error;
}
rejectOperation?.(new Error('late provider failure'));
await new Promise<void>((resolve) => setImmediate(resolve));

process.stdout.write(
  JSON.stringify({
    originalAbort: caught === abortReason,
    unhandled: unhandled.length,
  }),
);
