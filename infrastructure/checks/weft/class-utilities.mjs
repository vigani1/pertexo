// A variant separator only counts outside an arbitrary selector or value.
export function utility(token) {
  let depth = 0;
  let start = 0;
  for (let index = 0; index < token.length; index += 1) {
    switch (token[index]) {
      case '\\':
        index += 1;
        break;
      case '[':
      case '(':
        depth += 1;
        break;
      case ']':
      case ')':
        depth -= 1;
        break;
      case ':':
        if (depth === 0) start = index + 1;
        break;
      default:
        break;
    }
  }
  return token.slice(start).replace(/^!|!$/g, '');
}

export const rawColor =
  /(?<![\w/#.%&?-])#(?:[0-9a-f]{8}|[0-9a-f]{6}|[0-9a-f]{4}|[0-9a-f]{3})(?![\w-])|\b(?:rgba?|hsla?|oklch)\(/i;
export const rawColorMessage = 'Use a Weft theme color token.';

const palette =
  /^(?:black|white|(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose|mauve|olive|mist|taupe)-(?:50|[1-9]00|950))$/;
const colorRole =
  /^(?:accent|bg|border(?:-[xysetrbl])?|caret|decoration|divide|drop-shadow|fill|from|inset-ring|inset-shadow|outline|placeholder|ring-offset|ring|shadow|stroke|text-shadow|text|to|via)-(.*)$/;
const arbitraryColor =
  /^(?:color:|(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color|color-mix|light-dark)\(|(?:[a-z]+|#[0-9a-f]+)$)/i;
const arbitraryKeyword =
  /^(?:auto|baseline|bold|bottom|center|contain|cover|currentColor|dashed|dotted|end|hidden|inherit|initial|left|none|normal|revert|right|solid|start|top|unset)$/i;

export function unthemedColor(name) {
  const payload = colorRole.exec(name)?.[1];
  if (!payload) return false;
  const value = payload.replace(/\/(?:[\d.]+|\[[^\]]+\]|\(--[\w-]+\))$/, '');
  if (palette.test(value)) return true;
  const arbitrary = /^\[(.*)\]$/.exec(value)?.[1];
  return Boolean(
    arbitrary &&
    arbitraryColor.test(arbitrary) &&
    !arbitraryKeyword.test(arbitrary) &&
    !/^color:var\(--[\w-]+\)$/.test(arbitrary),
  );
}

export const fivePixelRadius =
  /^rounded(?:-[setrbl]{1,2})?-\[(?:5(?:\.0+)?px|0?\.31250*rem)\]$/;

const textLayout =
  /^text-(?:left|center|right|justify|start|end|wrap|nowrap|balance|pretty|clip|ellipsis)$/;
const strokeGeometry =
  /^(?:border|divide|outline|ring-offset|ring|stroke)(?:-[xysetrbl])?(?:-(?:\d+|solid|dashed|dotted|double|hidden|none|\[(?:length:.+|[\d.]+[a-z]*)\]|\(length:--[\w-]+\)))?$/;
const backgroundLayout =
  /^bg-(?:(?:auto|cover|contain|fixed|local|scroll|center|no-repeat|(?:top|bottom|left|right)(?:-(?:top|bottom|left|right))?)$|repeat(?:-|$)|position-|size-|\[(?:position|length|size):)/;
const appearanceProperty =
  /^\[(?:[\w-]*color|[\w-]*radius|background(?:-[\w-]+)?|font(?:-[\w-]+)?|line-height|letter-spacing|box-shadow|text-shadow):/;

export function changesAppearance(name) {
  if (
    textLayout.test(name) ||
    strokeGeometry.test(name) ||
    backgroundLayout.test(name)
  )
    return false;
  return (
    colorRole.test(name) ||
    appearanceProperty.test(name) ||
    /^(?:rounded|shadow|inset-shadow|drop-shadow|text-shadow|font|leading|tracking|uppercase|lowercase|capitalize|normal-case|italic|not-italic|underline|no-underline|line-through|antialiased|subpixel-antialiased|tabular-nums|proportional-nums)(?:-|$)/.test(
      name,
    )
  );
}
