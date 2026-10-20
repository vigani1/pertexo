import { STORED_EXECUTION_VALUE_LIMITS } from '@pertexo/node-sdk';
import type { ChildNode, Element } from 'domhandler';
import { parse, SelectorType, type Selector } from 'css-what';
import { selectAll } from 'css-select';
import { textContent } from 'domutils';
import type { HtmlConfig } from './validation.js';
import { parseBoundedHtml } from './parse.js';
import { refuseUtility } from '../result.js';

const ALLOWED_SELECTOR_TYPES = new Set([
  'tag',
  'universal',
  'attribute',
  'descendant',
  'child',
  'adjacent',
]);
const STRUCTURAL_PSEUDOS = new Set([
  'root',
  'empty',
  'first-child',
  'last-child',
  'only-child',
  'first-of-type',
  'last-of-type',
  'only-of-type',
  'nth-child',
  'nth-last-child',
  'nth-of-type',
  'nth-last-of-type',
]);
function supportedSelector(token: Selector): boolean {
  return token.type === SelectorType.Pseudo
    ? STRUCTURAL_PSEUDOS.has(token.name) && !Array.isArray(token.data)
    : ALLOWED_SELECTOR_TYPES.has(token.type);
}
export function extractHtml(
  config: HtmlConfig,
  value: string,
  signal: AbortSignal,
) {
  let selector;
  try {
    selector = parse(config.selector);
  } catch {
    return refuseUtility(
      'html_selector',
      'The CSS selector is malformed. Use tags, classes, IDs, attributes or combinators.',
    );
  }
  if (
    selector.length > 4 ||
    selector.flat().length > 16 ||
    selector.flat().some((token) => !supportedSelector(token)) ||
    selector.some(
      (group) =>
        group.filter((token) => token.type === SelectorType.Descendant).length >
          1 ||
        group.filter((token) => token.type === SelectorType.Pseudo).length > 1,
    )
  )
    return refuseUtility(
      'html_selector',
      'Use up to four selector groups and 16 tokens, with one descendant and one structural pseudo-class per group. Use child (>) or adjacent (+) links for longer paths; general sibling (~), nested selectors and pseudo-elements are not supported.',
    );
  const dom = parseBoundedHtml(value, signal);
  let matches: Element[];
  try {
    // This tree is owned and immutable during the query, so ancestor caches are safe.
    matches = selectAll<ChildNode, Element>(selector, dom, {
      cacheResults: true,
    });
  } catch {
    return refuseUtility(
      'html_selector',
      'This CSS selector is not supported. Check its syntax and structural pseudo-class arguments.',
    );
  }
  const items: string[] = [];
  let bytes = 0;
  for (const element of matches.slice(0, config.limit)) {
    signal.throwIfAborted();
    const attribute =
      config.operation === 'attribute' ? config.attribute.toLowerCase() : '';
    const item =
      config.operation === 'text'
        ? textContent(element)
        : Object.hasOwn(element.attribs, attribute)
          ? (element.attribs[attribute] ?? '')
          : '';
    bytes += Buffer.byteLength(JSON.stringify(item)) + 1;
    if (bytes > STORED_EXECUTION_VALUE_LIMITS.inlineBytes)
      refuseUtility(
        'result_too_large',
        'The extracted HTML result exceeds the step data limits. Choose fewer matches or split the document.',
      );
    items.push(item);
  }
  return {
    items,
    matchCount: matches.length,
    truncated: matches.length > config.limit,
  };
}
