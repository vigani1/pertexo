import { isRecord } from '@pertexo/workflow-model';
import { withConfigValue, type NodeConfig } from './draft';
import type { NodeFormApi } from './node-form';

/** Nested fields edit the current draft, preserving sibling edits made since render. */
export function nestedConfigForm(form: NodeFormApi, key: string): NodeFormApi {
  return {
    ...form,
    reportScratch: (field, scratch) => {
      form.reportScratch(`${key}:${field}`, scratch);
    },
    commit: (update, coalesceKey) => {
      form.commit((node) => {
        const child = isRecord(node.config[key])
          ? (node.config[key] as NodeConfig)
          : {};
        const change =
          typeof update === 'function'
            ? update({ ...node, config: child })
            : update;
        return change.config === undefined
          ? {}
          : { config: withConfigValue(node.config, key, change.config) };
      }, `${key}:${coalesceKey}`);
    },
  };
}
