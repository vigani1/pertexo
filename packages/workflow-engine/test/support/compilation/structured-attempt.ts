import { createHash } from 'node:crypto';

import {
  buildWorkflowExecutable,
  composeExecutableCatalog,
} from '../../../src/index.js';
import { nodeCatalog, forEachGraph } from '../executable-workflow.js';
export function structuredAttemptFixture() {
  const executable = buildWorkflowExecutable({
    graph: forEachGraph(),
    catalog: composeExecutableCatalog(nodeCatalog({ forEach: true })),
  });
  const iterationPath = [{ loopNodeId: 'loop', ordinal: 1 }] as const;
  const collection = [{ name: 'first' }, { name: 'nearest' }] as const;
  const declaredCollectionChecksum = createHash('sha256')
    .update(JSON.stringify(collection))
    .digest('hex');
  return {
    collection,
    declaredCollectionChecksum,
    executable,
    iterationPath,
  };
}
