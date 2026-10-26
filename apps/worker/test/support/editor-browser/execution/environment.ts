import { createRedisTestNamespace } from '../../infrastructure/redis-test-namespace.js';

export const codeCase = ['code', 'pinned-samples'].includes(
  process.env.EDITOR_BROWSER_CASE ?? '',
);

export const scheduleCase = process.env.EDITOR_BROWSER_CASE === 'schedule';

export const errorWorkflowCase =
  process.env.EDITOR_BROWSER_CASE === 'error-workflows';

export const webhookResponseCase =
  process.env.EDITOR_BROWSER_CASE === 'webhook-responses';

const paginationCase = process.env.EDITOR_BROWSER_CASE === 'http-pagination';

export const previewCase =
  process.env.EDITOR_BROWSER_CASE === 'artifact-inputs' ||
  process.env.EDITOR_BROWSER_CASE === 'variables' ||
  process.env.EDITOR_BROWSER_CASE === 'transforms' ||
  process.env.EDITOR_BROWSER_CASE === 'pinned-samples' ||
  webhookResponseCase ||
  paginationCase ||
  codeCase;

export const artifactInputs =
  process.env.EDITOR_BROWSER_CASE === 'artifact-inputs';

export const emailAttachments =
  process.env.EDITOR_BROWSER_CASE === 'email-attachments';

/** Form uploads read real stored files without any controlled HTTP. */
export const formUploadsCase =
  process.env.EDITOR_BROWSER_CASE === 'form-uploads';

export const controlledHttp =
  process.env.EDITOR_BROWSER_CASE === 'webhook-controlled-http' ||
  process.env.EDITOR_BROWSER_CASE === 'failure-routing' ||
  artifactInputs ||
  paginationCase;

export const curatedTemplates =
  process.env.EDITOR_BROWSER_CASE === 'curated-templates';

export function createEditorWorkerNamespace(redisUrl: string) {
  const namespace = createRedisTestNamespace(
    redisUrl,
    11,
    'editor-browser-pure-core',
    {
      beforeCleanup: async () => {
        if (!process.connected || process.send === undefined)
          throw new Error('Cleanup ownership cannot be verified');
        await new Promise<void>((resolve, reject) => {
          const finish = (error?: Error) => {
            clearTimeout(timer);
            process.off('message', message);
            if (error === undefined) resolve();
            else reject(error);
          };
          const message = (value: unknown) => {
            if (
              typeof value !== 'object' ||
              value === null ||
              !('phase' in value)
            )
              return;
            if (value.phase === 'namespace-cleanup-approved') finish();
            else if (value.phase === 'namespace-cleanup-denied')
              finish(
                new Error('Cleanup ownership changed; preserve namespace'),
              );
          };
          const timer = setTimeout(() => {
            finish(new Error('Cleanup ownership verification timed out'));
          }, 5_000);
          process.on('message', message);
          process.send?.({ phase: 'namespace-cleanup-request' });
        });
      },
    },
  );
  return namespace;
}
