import { describeFileInputFailure } from './describe-failure.js';
import { NodeExecutorFailure } from '../execution/errors.js';
import {
  fileInputDiagnosticSchema,
  FILE_INPUT_ERROR_CODE,
  type FileInputDiagnostic,
} from './diagnostic.js';

/** File content is untrusted; only this closed numeric diagnostic leaves its parser. */
export class FileInputFailure extends NodeExecutorFailure {
  readonly diagnostic: FileInputDiagnostic;
  constructor(diagnostic: FileInputDiagnostic) {
    const parsed = Object.freeze(fileInputDiagnosticSchema.parse(diagnostic));
    super({
      kind: 'failed',
      errorKind: 'configuration',
      possiblyDispatched: false,
      safeErrorCode: FILE_INPUT_ERROR_CODE,
      errorSummary: describeFileInputFailure(parsed),
    });
    this.diagnostic = parsed;
  }
}
