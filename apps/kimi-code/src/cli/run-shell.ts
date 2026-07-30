import type { CLIOptions } from './options';
import { runV2Shell } from './v2/run-v2-shell';

/**
 * Run the interactive CLI through the v2 Runtime + Klient composition root.
 *
 * Keep this small wrapper as the stable CLI entry so command dispatch and
 * tests do not depend on the concrete runtime module.
 */
export async function runShell(
  opts: CLIOptions,
  version: string,
  runOptions: { readonly migrateOnly?: boolean } = {},
): Promise<void> {
  await runV2Shell(opts, version, runOptions);
}
