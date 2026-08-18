import { createApiApplication } from './app.js';
import { parseApiConfig } from './platform/config/api-config.js';

async function bootstrap(): Promise<void> {
  const config = parseApiConfig();
  const application = await createApiApplication(config);

  await application.listen({ host: config.host, port: config.port });
}

void bootstrap().catch((error: unknown) => {
  console.error('API bootstrap failed', error);
  process.exitCode = 1;
});
