import {
  changesAppearance,
  fivePixelRadius,
  rawColor,
  rawColorMessage,
  unthemedColor,
  utility,
} from './class-utilities.mjs';
import {
  classStrings,
  currentOwner,
  sharedComponent,
  sourcePath,
  webPath,
} from './shared-components.mjs';

function rule(message, create) {
  return { meta: { schema: [], messages: { weft: message } }, create };
}

function utilityRule(message, rejects) {
  return rule(message, (context) => {
    function inspect(node, value) {
      for (const token of value.match(/\S+/g) ?? []) {
        if (rejects(utility(token))) {
          context.report({ node, messageId: 'weft', data: { token } });
        }
      }
    }
    return stringVisitors(inspect);
  });
}

function stringVisitors(inspect) {
  return {
    Literal(node) {
      if (typeof node.value === 'string') inspect(node, node.value);
    },
    TemplateElement(node) {
      inspect(node, node.value.cooked ?? node.value.raw);
    },
  };
}

const tokenCanvasFiles = new Set([
  'src/lib/canvas-scene.ts',
  'src/features/auth/components/stage/converging-threads-scene.ts',
  'src/features/workflow-runs/components/run-detail/timeline/loading-wave-renderer.ts',
]);

export const rules = {
  'no-raw-colors': rule(rawColorMessage, (context) => {
    if (tokenCanvasFiles.has(webPath(context.filename))) return {};
    return stringVisitors((node, value) => {
      if (
        !fragmentReference(node) &&
        rawColor.test(value.replace(/url\(['"]?#[\w-]+['"]?\)/g, ''))
      ) {
        context.report({ node, messageId: 'weft' });
      }
    });
  }),
  'semantic-color-utilities': utilityRule(
    'Replace {{token}} with a semantic Weft color utility.',
    unthemedColor,
  ),
  'quick-duration-token': utilityRule(
    'Replace {{token}} with duration-(--duration-quick).',
    (name) => name === 'duration-150',
  ),
  'control-radius-token': utilityRule(
    'Replace {{token}} with the shared control radius (rounded-xs).',
    (name) => fivePixelRadius.test(name),
  ),
  'shared-component-appearance': rule(
    'Use the shared component’s appearance, variant or shape props for {{tokens}}. Keep className for layout.',
    (context) => ({
      JSXAttribute(node) {
        if (node.name.name !== 'className') return;
        const component = sharedComponent(context, node.parent.name);
        if (!component) return;
        const tokens = classStrings(node.value, context.sourceCode)
          .flatMap((value) => value.match(/\S+/g) ?? [])
          .filter((token) => overridesAppearance(component, utility(token)));
        if (tokens.length) {
          context.report({
            node,
            messageId: 'weft',
            data: { tokens: [...new Set(tokens)].join(' ') },
          });
        }
      },
    }),
  ),
  'no-retired-component-imports': rule(
    'This Weft component path has been retired. Use {{owner}}.',
    (context) => {
      function inspect(node, specifiers = []) {
        if (typeof node?.value !== 'string') return;
        const path = sourcePath(context.filename, node.value);
        const owner = currentOwner(path);
        if (owner) {
          context.report({ node, messageId: 'weft', data: { owner } });
          return;
        }
        for (const specifier of specifiers) {
          const name = specifier.imported?.name ?? specifier.local?.name;
          const replacement = currentOwner(`${path}:${name}`);
          if (replacement) {
            context.report({
              node: specifier,
              messageId: 'weft',
              data: { owner: replacement },
            });
          }
        }
      }
      return {
        ImportDeclaration: (node) => inspect(node.source, node.specifiers),
        ExportNamedDeclaration: (node) => inspect(node.source, node.specifiers),
        ExportAllDeclaration: (node) => inspect(node.source),
        ImportExpression: (node) => inspect(node.source),
      };
    },
  ),
  'feature-hook-placement': rule(
    'Place feature hooks under the feature’s hooks/ directory.',
    (context) => ({
      Program(node) {
        if (
          /^src\/features\/[^/]+\/components\/(?:.*\/)?use-[^/]+\.tsx?$/.test(
            webPath(context.filename),
          )
        ) {
          context.report({ node, messageId: 'weft' });
        }
      },
    }),
  ),
  'tsx-requires-jsx': rule(
    'Use a .ts extension for modules without JSX.',
    (context) => {
      if (!context.filename.endsWith('.tsx')) return {};
      let hasJsx = false;
      return {
        'JSXElement, JSXFragment'() {
          hasJsx = true;
        },
        'Program:exit'(node) {
          if (!hasJsx) context.report({ node, messageId: 'weft' });
        },
      };
    },
  ),
  'native-disclosure-owner': rule(
    'Use Disclosure from @/components/ui/disclosure.',
    (context) => {
      if (webPath(context.filename) === 'src/components/ui/disclosure.tsx')
        return {};
      return {
        JSXOpeningElement(node) {
          if (node.name.name === 'details' || node.name.name === 'summary') {
            context.report({ node, messageId: 'weft' });
          }
        },
      };
    },
  ),
};

function overridesAppearance({ path, name }, utilityName) {
  return (
    changesAppearance(utilityName) ||
    (path === 'components/ui/disclosure' &&
      name === 'Disclosure' &&
      /^border-t(?:-|$)/.test(utilityName)) ||
    (path === 'components/ui/toggle-group' &&
      name === 'ToggleGroup' &&
      utilityName === 'border-0')
  );
}

function fragmentReference(node) {
  const value = node.type === 'TemplateElement' ? node.parent : node;
  const use =
    value.parent.type === 'JSXExpressionContainer'
      ? value.parent.parent
      : value.parent;
  return (
    (use.type === 'JSXAttribute' &&
      /^(?:href|xlinkHref|src|hash)$/.test(use.name.name)) ||
    (use.type === 'CallExpression' &&
      use.callee.type === 'MemberExpression' &&
      /^(?:querySelector|querySelectorAll|closest|matches)$/.test(
        use.callee.property.name,
      ))
  );
}
