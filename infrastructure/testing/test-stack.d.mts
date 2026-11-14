export declare const TEST_STACK_SETTINGS: readonly string[];
export declare function testStackSetting(
  name: string,
  environment?: Readonly<Record<string, string | undefined>>,
): string;
export declare function requireTestStack(
  names?: readonly string[],
  environment?: Readonly<Record<string, string | undefined>>,
): void;
