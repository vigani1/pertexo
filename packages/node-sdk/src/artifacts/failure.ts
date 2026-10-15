import { NodeExecutorFailure } from '../executor-errors.js';
import {
  fileInputDiagnosticSchema,
  type FileInputDiagnostic,
} from './diagnostic.js';

/** File content is untrusted; only this closed numeric diagnostic leaves its parser. */
export class FileInputFailure extends NodeExecutorFailure {
  readonly diagnostic: FileInputDiagnostic;
  constructor(diagnostic: FileInputDiagnostic) {
    super({
      kind: 'failed',
      errorKind: 'configuration',
      possiblyDispatched: false,
    });
    this.diagnostic = Object.freeze(
      fileInputDiagnosticSchema.parse(diagnostic),
    );
  }
}
