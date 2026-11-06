/** Reconstruct function identities from top-level migration DDL, never routine bodies. */
export function liveSqlFunctions(source) {
  const functions = new Set();
  for (const statement of statements(source)) {
    const command =
      /^(CREATE(?:\s+OR\s+REPLACE)?|DROP)\s+FUNCTION\s+(?:IF\s+EXISTS\s+)?/iu.exec(
        statement,
      );
    if (command === null) continue;
    let rest = statement.slice(command[0].length);
    do {
      const name =
        /^((?:"[a-z0-9_]+"|[a-z_][a-z0-9_]*)\s*\.\s*(?:"[a-z0-9_]+"|[a-z_][a-z0-9_]*))\s*\(/iu.exec(
          rest,
        );
      if (name === null)
        throw new Error(
          'SQL functions must have explicit schema and argument identities',
        );
      const qualified = name[1]
        .split('.')
        .map((part) => {
          const identifier = part.trim();
          return identifier.startsWith('"')
            ? identifier.slice(1, -1)
            : identifier.toLowerCase();
        })
        .join('.');
      const { arguments: args, remaining } = argumentsAfter(
        rest.slice(name[0].length),
      );
      const identity = `${qualified}(${args.map(argumentType).filter(Boolean).join(',')})`;
      if (command[1].toUpperCase() === 'DROP') functions.delete(identity);
      else functions.add(identity);
      rest = remaining.trimStart();
      if (command[1].toUpperCase() !== 'DROP' || !rest.startsWith(',')) break;
      rest = rest.slice(1).trimStart();
    } while (rest.length > 0);
  }
  return functions;
}

function argumentType(argument) {
  if (/^OUT\s/iu.test(argument)) return '';
  let type = argument
    .replace(/^(?:IN|INOUT|VARIADIC)\s+/iu, '')
    .split(/\s+DEFAULT\s+|\s*=/iu)[0]
    .trim();
  // Names in migration declarations are optional; identity never includes them.
  const first = /^("[^"]+"|[^\s]+)\s+/u.exec(type);
  const builtins =
    /^(?:bigint|boolean|bool|bpchar|char|character|date|double|float8|integer|int|int4|int8|json|jsonb|numeric|real|regclass|smallint|text|timestamp|timestamptz|uuid|varchar)(?:\[|\(|$)/iu;
  if (first !== null && (first[1].startsWith('"') || !builtins.test(first[1])))
    type = type.slice(first[0].length);
  type = type
    .toLowerCase()
    .replaceAll('pg_catalog.', '')
    .replaceAll('"', '')
    .replaceAll(/\([\d,\s]+\)/gu, '')
    .replaceAll(/\s+/gu, ' ')
    .replaceAll(/\s*\[\s*\]/gu, '[]')
    .trim();
  return type
    .replace(/^varchar\b/u, 'character varying')
    .replace(/^(?:char|bpchar)\b/u, 'character')
    .replace(/^(?:int|int4)\b/u, 'integer')
    .replace(/^int8\b/u, 'bigint')
    .replace(/^bool\b/u, 'boolean')
    .replace(/^float8\b/u, 'double precision')
    .replace(/^timestamptz\b/u, 'timestamp with time zone');
}

function argumentsAfter(source) {
  const args = [];
  let start = 0,
    parentheses = 0,
    brackets = 0,
    quote;
  for (let i = 0; i < source.length; i++) {
    const char = source[i];
    if (quote !== undefined) {
      if (char === quote && source[i + 1] === quote) i++;
      else if (char === quote) quote = undefined;
      continue;
    }
    if (char === "'" || char === '"') quote = char;
    else if (char === '(') parentheses++;
    else if (char === ')' && parentheses > 0) parentheses--;
    else if (char === '[') brackets++;
    else if (char === ']') brackets--;
    else if (
      (char === ',' || char === ')') &&
      parentheses === 0 &&
      brackets === 0
    ) {
      const argument = source.slice(start, i).trim();
      if (argument) args.push(argument);
      if (char === ')')
        return { arguments: args, remaining: source.slice(i + 1) };
      start = i + 1;
    }
  }
  throw new Error('SQL function argument list is incomplete');
}

function statements(source) {
  const result = [];
  let current = '',
    quote,
    dollar,
    commentDepth = 0;
  for (let i = 0; i < source.length; i++) {
    const char = source[i];
    if (commentDepth > 0) {
      if (source.startsWith('/*', i)) {
        commentDepth++;
        i++;
      } else if (source.startsWith('*/', i)) {
        commentDepth--;
        i++;
      }
      continue;
    }
    if (dollar !== undefined) {
      if (source.startsWith(dollar, i)) {
        current += dollar;
        i += dollar.length - 1;
        dollar = undefined;
      } else current += char;
      continue;
    }
    if (quote !== undefined) {
      current += char;
      if (char === quote && source[i + 1] === quote) {
        current += char;
        i++;
      } else if (char === quote) quote = undefined;
      continue;
    }
    if (source.startsWith('--', i)) {
      const end = source.indexOf('\n', i);
      i = end < 0 ? source.length : end;
      current += ' ';
      continue;
    }
    if (source.startsWith('/*', i)) {
      commentDepth = 1;
      i++;
      current += ' ';
      continue;
    }
    if (char === "'" || char === '"') quote = char;
    const delimiter =
      char === '$'
        ? /^(?:\$\$|\$[a-z_][a-z0-9_]*\$)/iu.exec(source.slice(i))
        : null;
    if (delimiter !== null) {
      dollar = delimiter[0];
      current += dollar;
      i += dollar.length - 1;
    } else if (char === ';') {
      if (current.trim()) result.push(current.trim());
      current = '';
    } else current += char;
  }
  if (quote !== undefined || dollar !== undefined || commentDepth !== 0)
    throw new Error(
      'Migration SQL contains an unterminated quoted value or comment',
    );
  if (current.trim()) result.push(current.trim());
  return result;
}
