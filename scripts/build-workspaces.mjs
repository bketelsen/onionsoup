import { execFileSync } from 'node:child_process';
import { cp, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
await rm('.build', { recursive: true, force: true });
execFileSync(process.execPath, ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.build.json'], { stdio: 'inherit' });
for (const group of ['packages']) {
  for (const name of await readdir(group)) {
    const directory = join(group, name);
    const destination = join(directory, 'dist');
    await rm(destination, { recursive: true, force: true });
    await cp(join('.build', group, name, 'src'), destination, { recursive: true });
    // Harness scripts and other non-TypeScript assets ship next to the compiled modules.
    await cp(join(directory, 'src'), destination, { recursive: true, filter: (source) => !/\.ts$/.test(source) });
  }
}
await rm('.build', { recursive: true, force: true });
