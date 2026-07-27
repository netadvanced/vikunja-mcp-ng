/**
 * Guards server.json (the MCP registry manifest) against drifting from
 * package.json — issue #186. server.json is a static published manifest, not
 * runtime state, so nothing derives it automatically; this is the cheap unit
 * check the release process (scripts/release-prepare.sh) must keep green.
 */
import * as fs from 'fs';
import * as path from 'path';

const REPO_ROOT = path.resolve(__dirname, '..');

describe('server.json version fields', () => {
  const packageJson = JSON.parse(
    fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf-8'),
  ) as {
    version: string;
  };
  const serverJson = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'server.json'), 'utf-8')) as {
    version: string;
    packages: Array<{ version: string }>;
  };

  it('top-level .version matches package.json', () => {
    expect(serverJson.version).toBe(packageJson.version);
  });

  it('.packages[0].version matches package.json', () => {
    expect(serverJson.packages[0]?.version).toBe(packageJson.version);
  });
});
