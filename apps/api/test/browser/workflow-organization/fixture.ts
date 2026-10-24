import type { ChildProcess } from 'node:child_process';

import { writeFile } from 'node:fs/promises';

import { FixtureResourceOwner } from '../harness/resource-owner.js';
import { ownEditorBrowserProcess } from '../harness/process.js';
import { closeOrganizationBrowserBarriers } from '../workflow-organization-lifetime.js';
import { useOrganizationOwnedApi } from '../../workflow-authoring/organization/support/owned-api.fixture.js';
import { webOrigin } from './environment.js';

export function createWorkflowOrganizationJourney({
  role,
}: {
  readonly role: 'viewer' | 'builder' | 'admin';
}) {
  const owner = new FixtureResourceOwner();

  const openBrowsers = new Set<string>();

  const barriers: ReturnType<typeof ownEditorBrowserProcess>[] = [];

  const pending = new Set<Promise<void>>();

  let opened = false;

  let observed = false;

  let closing = false;

  let browserPhase = 'startup';

  let failureLine = 0;

  let identityFailure = 'unknown';

  let controlFailure = 'unknown';

  let publicEvidence: unknown;

  const testResults: {
    case: 'owner';
    status: 'passed' | 'failed';
  }[] = [];

  const { api } = useOrganizationOwnedApi(`organization_browser_${role}`, {
    publicWebOrigin: webOrigin,
    beforeClose: async () => {
      closing = true;
      await Promise.allSettled([...pending]);
      // A failed descendant barrier stops cleanup before the aggregate owner
      // can release the control listener. The API fixture preserves its DB.
      await closeOrganizationBrowserBarriers(barriers);
      await owner.close();
      if (publicEvidence !== undefined)
        await writeFile(
          `/tmp/pertexo-workflow-organization-${role}.public.json`,
          JSON.stringify(
            {
              case: role,
              evidence: publicEvidence,
              selectedTestResults: testResults,
              lifetime: {
                browserOpenedReceipt: opened,
                browserDisposedReceipts: openBrowsers.size === 0,
                ownedProcessBarriersClosed: true,
                databaseCleanup: 'fixture continues after this receipt',
              },
            },
            null,
            2,
          ),
          { mode: 0o600 },
        );
    },
  });

  function ownChild(child: ChildProcess, kind: 'vite' | 'browser') {
    const barrier = ownEditorBrowserProcess(child, kind, {
      browserDisposed: () => opened && openBrowsers.size === 0,
    });
    barriers.push(barrier);
    return owner.acquire(kind, child, () => barrier.close());
  }

  function successfulExit(child: ChildProcess, phase: string) {
    return new Promise<void>((resolve, reject) => {
      child.once('error', () => {
        reject(new Error(`Owned F07 ${phase} startup failed`));
      });
      child.once('exit', (code) => {
        if (code === 0) resolve();
        else
          reject(
            new Error(
              `Owned F07 ${phase} exited unsuccessfully at ${browserPhase} line ${String(failureLine)} identity ${identityFailure} control ${controlFailure}`,
            ),
          );
      });
    });
  }
  return {
    api,
    owner,
    get observed() {
      return observed;
    },
    set observed(value: typeof observed) {
      observed = value;
    },
    get closing() {
      return closing;
    },
    set closing(value: typeof closing) {
      closing = value;
    },
    get failureLine() {
      return failureLine;
    },
    set failureLine(value: typeof failureLine) {
      failureLine = value;
    },
    get controlFailure() {
      return controlFailure;
    },
    set controlFailure(value: typeof controlFailure) {
      controlFailure = value;
    },
    get identityFailure() {
      return identityFailure;
    },
    set identityFailure(value: typeof identityFailure) {
      identityFailure = value;
    },
    role,
    get publicEvidence() {
      return publicEvidence;
    },
    set publicEvidence(value: typeof publicEvidence) {
      publicEvidence = value;
    },
    testResults,
    get browserPhase() {
      return browserPhase;
    },
    set browserPhase(value: typeof browserPhase) {
      browserPhase = value;
    },
    openBrowsers,
    get opened() {
      return opened;
    },
    set opened(value: typeof opened) {
      opened = value;
    },
    pending,
    ownChild,
    successfulExit,
  };
}
