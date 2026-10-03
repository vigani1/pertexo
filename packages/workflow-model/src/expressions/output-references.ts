import jsonata from 'jsonata';
import {
  expressionError,
  readJsonataAst,
  validateExpression,
  type ExpressionResult,
  type JsonataAst,
} from './policy.js';

export type ExpressionNodeOutputReferences =
  | { readonly kind: 'valid'; readonly nodeIds: readonly string[] | 'all' }
  | Extract<ExpressionResult, { kind: 'error' }>;

type ReferenceScope = 'root' | 'outputs' | 'local';
type ReferenceScopes = ReadonlySet<ReferenceScope>;
const LOCAL: ReferenceScopes = new Set(['local']);

function isArray(value: unknown): value is readonly unknown[] {
  return Array.isArray(value);
}

/** Static dependencies of an already policy-admitted AST, not an evaluator. */
class OutputReferenceInspector {
  private readonly nodeIds = new Set<string>();
  private all = false;

  inspect(ast: JsonataAst): readonly string[] | 'all' {
    this.consume(this.visit(ast, new Set(['root'])));
    return this.all ? 'all' : Object.freeze([...this.nodeIds].sort());
  }

  private consume(scopes: ReferenceScopes): void {
    if (scopes.has('root') || scopes.has('outputs')) this.all = true;
  }

  private select(scopes: ReferenceScopes, key: string): ReferenceScopes {
    const result = new Set<ReferenceScope>();
    for (const scope of scopes) {
      if (scope === 'outputs') this.nodeIds.add(key);
      result.add(
        scope === 'root' && key === 'nodeOutputs' ? 'outputs' : 'local',
      );
    }
    return result;
  }

  private block(node: JsonataAst, scopes: ReferenceScopes): ReferenceScopes {
    if (!isArray(node.expressions) || node.expressions.length === 0)
      throw new TypeError('invalid dependency block');
    let result = LOCAL;
    for (const [index, expression] of node.expressions.entries()) {
      result = this.visit(expression, scopes);
      if (index < node.expressions.length - 1) this.consume(result);
    }
    return result;
  }

  private call(node: JsonataAst, scopes: ReferenceScopes): ReferenceScopes {
    const procedure = readJsonataAst(node.procedure);
    if (!isArray(node.arguments))
      throw new TypeError('invalid dependency arguments');
    const [input, key] = node.arguments;
    if (procedure.value === 'lookup' && node.arguments.length === 2) {
      const keyAst = readJsonataAst(key);
      if (keyAst.type === 'string' && typeof keyAst.value === 'string')
        return this.select(this.visit(input, scopes), keyAst.value);
    }
    if (node.arguments.length === 0) this.consume(scopes);
    for (const argument of node.arguments)
      this.consume(this.visit(argument, scopes));
    return LOCAL;
  }

  private container(
    node: JsonataAst,
    scopes: ReferenceScopes,
  ): ReferenceScopes {
    const children = (child: unknown): void => {
      if (isArray(child)) {
        for (const item of child) children(item);
      } else if (child !== null && typeof child === 'object') {
        this.consume(this.visit(child, scopes));
      }
    };
    for (const [key, child] of Object.entries(node)) {
      if (!['type', 'value', 'position', 'stages'].includes(key))
        children(child);
    }
    return LOCAL;
  }

  private step(node: JsonataAst, scopes: ReferenceScopes): ReferenceScopes {
    switch (node.type) {
      case 'path': {
        if (!isArray(node.steps) || node.steps.length === 0)
          throw new TypeError('invalid dependency path');
        let result = scopes;
        for (const child of node.steps) result = this.visit(child, result);
        return result;
      }
      case 'name':
        if (typeof node.value !== 'string')
          throw new TypeError('invalid dependency name');
        return this.select(scopes, node.value);
      case 'variable':
        if (node.value !== '')
          throw new TypeError('invalid dependency variable');
        return scopes;
      case 'wildcard':
        this.consume(scopes);
        return LOCAL;
      case 'parent':
        // Policy v1 rejects parent tuple metadata; conservatively cover root
        // escape if its admitted representation changes in a future parser.
        this.all = true;
        return LOCAL;
      case 'block':
        return this.block(node, scopes);
      case 'condition':
        this.consume(this.visit(node.condition, scopes));
        return new Set([
          ...this.visit(node.then, scopes),
          ...(node.else === undefined ? LOCAL : this.visit(node.else, scopes)),
        ]);
      case 'function':
        return this.call(node, scopes);
      case 'filter':
        this.consume(this.visit(node.expr, scopes));
        return scopes;
      case 'string':
      case 'number':
      case 'value':
        return LOCAL;
      case 'binary':
      case 'unary':
        return this.container(node, scopes);
      default:
        throw new TypeError('unsupported dependency AST');
    }
  }

  private visit(value: unknown, scopes: ReferenceScopes): ReferenceScopes {
    const node = readJsonataAst(value);
    let result = this.step(node, scopes);
    if (node.stages !== undefined) {
      if (!isArray(node.stages))
        throw new TypeError('invalid dependency stages');
      for (const stage of node.stages) result = this.visit(stage, result);
    }
    return result;
  }
}

/**
 * Root output dependencies for durable result selection. Whole/dynamic root
 * access requires every output. Nested runInput/selected-output navigation does
 * not introduce unrelated root dependencies. The existing policy owns grammar
 * and bounds; inspection neither evaluates nor changes expression admission.
 */
export function inspectExpressionNodeOutputReferences(
  source: string,
  policyVersion: number,
): ExpressionNodeOutputReferences {
  const validation = validateExpression(source, policyVersion);
  if (validation.kind === 'error') return validation;
  try {
    return Object.freeze({
      kind: 'valid',
      nodeIds: new OutputReferenceInspector().inspect(
        readJsonataAst(jsonata(source).ast()),
      ),
    });
  } catch {
    return expressionError(
      'invalid_expression',
      'expression dependencies could not be inspected',
    );
  }
}
