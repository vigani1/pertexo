import postcss from 'postcss';
import { rawColor, rawColorMessage } from './class-utilities.mjs';

// ESLint has no CSS parser in this workspace. Report against the original
// declarations so selectors such as #abc and comments are outside the rule.
const findings = new Map();

export const styles = {
  preprocess(text, filename) {
    const messages = [];
    try {
      postcss.parse(text, { from: filename }).walkDecls((declaration) => {
        const value = declaration.value.replace(/url\([^)]*\)/gi, '');
        if (rawColor.test(value)) {
          const { line, column } = declaration.source.start;
          messages.push({
            ruleId: 'weft/no-raw-colors',
            severity: 2,
            message: rawColorMessage,
            line,
            column,
          });
        }
      });
    } catch (error) {
      if (error.name !== 'CssSyntaxError') throw error;
      messages.push({
        severity: 2,
        fatal: true,
        message: error.reason,
        line: error.line,
        column: error.column,
      });
    }
    findings.set(filename, messages);
    return [];
  },
  postprocess(_messages, filename) {
    const messages = findings.get(filename);
    findings.delete(filename);
    return messages;
  },
};
