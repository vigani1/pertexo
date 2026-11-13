// How the transaction-local settings check reads SQL text: where strings,
// quoted identifiers, dollar quotes and comments begin and end.

const DOLLAR_QUOTE = /\$(?:[A-Za-z_]\w*)?\$/uy;

/**
 * The dollar-quote tag ($$ or $tag$) that starts at index, if one does. As in
 * PostgreSQL's lexer, a "$" right after an identifier character belongs to
 * the identifier (a$b$) and starts nothing.
 */
export function dollarQuoteAt(sql, index) {
  if (index > 0 && /[\w$]/u.test(sql[index - 1])) return undefined;
  DOLLAR_QUOTE.lastIndex = index;
  return DOLLAR_QUOTE.exec(sql)?.[0];
}

/** The quote at index opens an E'...' string, whose backslashes escape. */
export function opensEscapeString(sql, index) {
  return (
    sql[index] === "'" &&
    (sql[index - 1] === 'e' || sql[index - 1] === 'E') &&
    (index < 2 || !/[\w$]/u.test(sql[index - 2]))
  );
}

/**
 * The SQL with its -- and (nested) block comments replaced by a space,
 * outside strings and quoted identifiers. A comment can hold a ";" or a
 * quote that would otherwise move where a statement or an argument ends.
 * Dollar-quoted bodies are kept as written.
 */
export function withoutSqlComments(sql) {
  let text = '';
  let index = 0;
  while (index < sql.length) {
    const end = skippedTo(sql, index);
    if (end !== undefined) {
      text += ' ';
      index = end;
      continue;
    }
    const kept = keptTo(sql, index);
    text += sql.slice(index, kept);
    index = kept;
  }
  return text;
}

/** Where a comment starting at index ends, or undefined when none starts there. */
function skippedTo(sql, index) {
  if (sql.startsWith('--', index)) {
    const newline = sql.indexOf('\n', index);
    return newline === -1 ? sql.length : newline;
  }
  if (!sql.startsWith('/*', index)) return undefined;
  let depth = 0;
  let at = index;
  while (at < sql.length) {
    if (sql.startsWith('/*', at)) {
      depth += 1;
      at += 2;
    } else if (sql.startsWith('*/', at)) {
      depth -= 1;
      at += 2;
      if (depth === 0) return at;
    } else at += 1;
  }
  return sql.length;
}

/** Where the text kept from index ends: past a whole string, identifier or dollar quote. */
function keptTo(sql, index) {
  const tag = dollarQuoteAt(sql, index);
  if (tag !== undefined) {
    const close = sql.indexOf(tag, index + tag.length);
    return close === -1 ? sql.length : close + tag.length;
  }
  const quote = sql[index];
  if (quote !== "'" && quote !== '"') return index + 1;
  const escapes = opensEscapeString(sql, index);
  let at = index + 1;
  while (at < sql.length) {
    if (escapes && sql[at] === '\\') at += 2;
    else if (sql[at] === quote && sql[at + 1] === quote) at += 2;
    else if (sql[at] === quote) return at + 1;
    else at += 1;
  }
  return sql.length;
}
