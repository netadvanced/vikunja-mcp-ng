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

function main(argv: string[]): void {
  const shell = argv.includes('--shell');
  const json = argv.includes('--json');
  const list = argv.includes('--list');

  if (list) {
    console.log(standardTargets().map((t) => t.id).join('\n'));
    return;
  }

  const positional = argv.filter((a) => !a.startsWith('--'));
  const target = resolveTarget(positional[0] ?? process.env.VIKUNJA_E2E_TARGET ?? DEFAULT_TARGET);

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
    console.log(`E2E_DB_MODE='${target.dbMode}'`);
    console.log(`E2E_PROFILE='${target.profile}'`);
    console.log(`E2E_DB_NAME='${target.dbName}'`);
    return;
  }

  console.log(json ? JSON.stringify(target, null, 2) : target.id);
}

main(process.argv.slice(2));
