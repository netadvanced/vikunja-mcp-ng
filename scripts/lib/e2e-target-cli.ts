/**
 * CLI entry point for the e2e target resolver.
 *
 * Deliberately separate from e2e-target.ts: that module is imported by Jest
 * suites (via the battle harness), and Jest compiles to CommonJS where an
 * `import.meta` guard is a hard syntax error. Keeping the executable part
 * here leaves the library safe to import from anywhere.
 *
 *   npx tsx scripts/lib/e2e-target-cli.ts --shell 2.4.0-postgres
 *   npx tsx scripts/lib/e2e-target-cli.ts --list
 */

import { resolveTarget, standardTargets, DEFAULT_TARGET } from './e2e-target';

/**
 * Resolves the raw target id to hand to resolveTarget(), preferring the CLI
 * positional arg over the VIKUNJA_E2E_TARGET env var over DEFAULT_TARGET.
 *
 * Deliberately uses `||` rather than `??`: docker/e2e/bootstrap.sh invokes
 * this CLI as `--shell "${VIKUNJA_E2E_TARGET:-}"`, so an unset env var
 * arrives here as an empty-string *positional* arg, not a missing one. `??`
 * only treats `null`/`undefined` as absent, so it let `''` through to
 * resolveTarget() and failed its `<version>[-db]` regex instead of falling
 * back — a bare `npm run e2e:up` broke outright (#218). Treating `''` the
 * same as unset, for both the positional and the env var, fixes that.
 */
export function resolveTargetArg(
  positional: string | undefined,
  env: string | undefined = process.env.VIKUNJA_E2E_TARGET,
): string {
  return positional || env || DEFAULT_TARGET;
}

function main(argv: string[]): void {
  const shell = argv.includes('--shell');
  const json = argv.includes('--json');
  const list = argv.includes('--list');

  if (list) {
    console.log(standardTargets().map((t) => t.id).join('\n'));
    return;
  }

  const positional = argv.filter((a) => !a.startsWith('--'));
  const target = resolveTarget(resolveTargetArg(positional[0]));

  if (shell) {
    console.log(`E2E_TARGET_ID='${target.id}'`);
    console.log(`E2E_VERSION='${target.version}'`);
    console.log(`E2E_DB='${target.db}'`);
    console.log(`E2E_PROJECT='${target.project}'`);
    console.log(`E2E_PORT='${target.port}'`);
    console.log(`E2E_DB_PORT='${target.dbPort}'`);
    console.log(`E2E_API_URL='${target.apiUrl}'`);
    console.log(`E2E_ENV_FILE='${target.envFile}'`);
    console.log(`E2E_SERVICE='${target.service}'`);
    return;
  }

  console.log(json ? JSON.stringify(target, null, 2) : target.id);
}

// Guarded so importing this module (e.g. from a Jest test exercising
// resolveTargetArg) doesn't also run the CLI against the test runner's own
// argv. require.main is safe here (unlike an import.meta guard) because the
// repo compiles/executes this file as CommonJS either way — see the file
// header comment.
if (require.main === module) {
  main(process.argv.slice(2));
}
