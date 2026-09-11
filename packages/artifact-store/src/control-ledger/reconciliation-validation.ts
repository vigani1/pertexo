import type { ListObjectsV2CommandOutput } from '@aws-sdk/client-s3';

import type {
  ControlLedgerRecord,
  ReconcileControlLedgerRequest,
} from '../control-ledger.js';
import { ControlLedgerIntegrityError } from './errors.js';
import { recordKey } from './record-key.js';

type ReconciliationCursor = Readonly<
  Pick<
    ReconcileControlLedgerRequest,
    'maxRecords' | 'projectedHash' | 'projectedSequence' | 'workspaceId'
  >
>;

export function assertEmptyProjectionHash(
  cursor: ReconciliationCursor,
  zeroHash: string,
): void {
  if (cursor.projectedSequence === 0 && cursor.projectedHash !== zeroHash) {
    throw new ControlLedgerIntegrityError(
      'Empty projection must use the zero hash',
    );
  }
}

export function assertProjectionAnchor(
  anchor: ControlLedgerRecord | null,
  cursor: ReconciliationCursor,
): void {
  if (
    anchor?.workspaceId !== cursor.workspaceId ||
    anchor.sequence !== cursor.projectedSequence ||
    anchor.recordHash !== cursor.projectedHash
  ) {
    throw new ControlLedgerIntegrityError(
      'Control ledger projection anchor is invalid',
    );
  }
}

export function assertReconciliationListing(
  listed: ListObjectsV2CommandOutput,
  contents: readonly Readonly<{ Key?: string | undefined }>[],
  cursor: ReconciliationCursor,
): void {
  if (
    typeof listed.IsTruncated !== 'boolean' ||
    listed.KeyCount !== contents.length ||
    contents.length > cursor.maxRecords + 1 ||
    (listed.IsTruncated &&
      (contents.length !== cursor.maxRecords + 1 ||
        listed.NextContinuationToken === undefined ||
        listed.NextContinuationToken.length === 0)) ||
    (!listed.IsTruncated && listed.NextContinuationToken !== undefined)
  ) {
    throw new ControlLedgerIntegrityError(
      'Control ledger reconciliation list contract is invalid',
    );
  }
  for (const [index, item] of contents.entries()) {
    const expectedSequence = cursor.projectedSequence + index + 1;
    if (
      expectedSequence > Number.MAX_SAFE_INTEGER ||
      item.Key !== recordKey(cursor.workspaceId, expectedSequence)
    ) {
      throw new ControlLedgerIntegrityError(
        'Control ledger reconciliation keys are not consecutive',
      );
    }
  }
}

export function assertReconciliationProbe(
  probe: ControlLedgerRecord | null,
  pageEndHash: string,
): void {
  if (probe?.previousHash !== pageEndHash) {
    throw new ControlLedgerIntegrityError(
      'Control ledger reconciliation probe is invalid',
    );
  }
}
