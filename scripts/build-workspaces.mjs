import { execFileSync } from 'node:child_process';
import { cp, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
await rm('.build', { recursive: true, force: true });
execFileSync(process.execPath, ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.build.json'], { stdio: 'inherit' });
for (const group of ['packages', 'apps']) {
  for (const name of await readdir(group)) {
    const destination = join(group, name, 'dist');
    await rm(destination, { recursive: true, force: true });
    await cp(join('.build', group, name, 'src'), destination, { recursive: true });
  }
}
await rm('.build', { recursive: true, force: true });
