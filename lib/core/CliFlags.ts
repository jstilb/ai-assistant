/**
 * CliFlags — `--key value` argument parsing for Bun CLIs.
 *
 * Shared by Cooking's RecipeIndex cli and EventScout's cli (formerly two
 * copies of parseFlags + collectRepeatableFlag).
 */

/**
 * Split args into `--key value` flags and positional tokens (in order).
 * A `--flag` with no value (end of args, or followed by another `--…`) is
 * recorded as the string "true". A repeated key keeps its LAST value — use
 * collectRepeatableFlag() for flags that may repeat.
 */
export function parseFlags(args: string[]): { flags: Record<string, string>; positional: string[] } {
  const flags: Record<string, string> = {};
  const positional: string[] = [];
  let i = 0;
  while (i < args.length) {
    const arg = args[i]!;
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const next = args[i + 1];
      // Boolean flag: next token is absent or is itself a --flag
      if (next === undefined || next.startsWith("--")) {
        flags[key] = "true";
        i += 1;
      } else {
        flags[key] = next;
        i += 2;
      }
    } else {
      positional.push(arg);
      i += 1;
    }
  }
  return { flags, positional };
}

/**
 * Every `--flagName <value>` occurrence in args, in order — for flags that
 * may repeat (e.g. "--tag a --tag b" → ["a", "b"]), which parseFlags would
 * collapse to the last value.
 */
export function collectRepeatableFlag(args: string[], flagName: string): string[] {
  const needle = `--${flagName}`;
  const values: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === needle && i + 1 < args.length) {
      values.push(args[i + 1]!);
    }
  }
  return values;
}
