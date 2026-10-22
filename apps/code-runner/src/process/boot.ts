import type { JsonBounds } from '../execution/encode.js';
import type { ConsoleBounds } from '../execution/console.js';
import type { ModulePolicy } from '../execution/modules.js';

/** Trusted manager configuration, supplied before a task or user code exists. */
export type ChildBoot = Readonly<{
  json: JsonBounds;
  console: ConsoleBounds;
  modules: ModulePolicy;
  taskBytes: number;
  pythonModules: readonly string[];
  pythonPackages: readonly string[];
}>;
