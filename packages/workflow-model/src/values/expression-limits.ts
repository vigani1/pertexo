// Browser-safe: the editor checks an expression's size before the server's
// expression policy (expressions/expression-policy.ts) checks it again on save.
export const EXPRESSION_BYTES_MAX = 16_384;
