export declare const WORKERS: number;
export declare const parallelIntegrationSuite: Readonly<{
  environment: 'node';
  include: string[];
  pool: 'forks';
  fileParallelism: true;
  maxWorkers: number;
  testTimeout: number;
  hookTimeout: number;
  globalSetup: string[];
  setupFiles: string[];
}>;
export default function copyDatabases(): Promise<void>;
