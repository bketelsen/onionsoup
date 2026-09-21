import { execFileSync } from 'node:child_process';
import { access, cp, readdir, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
await rm('.build', { recursive: true, force: true });
execFileSync(process.execPath, ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.build.json'], { stdio: 'inherit' });
for (const group of ['packages', 'apps']) {
  for (const name of await readdir(group)) {
    const directory = join(group, name);
    const destination = join(directory, 'dist');
    await rm(destination, { recursive: true, force: true });
    if (await access(join(directory, 'vite.config.ts')).then(() => true, () => false)) {
      execFileSync(process.execPath, [resolve('node_modules/vite/bin/vite.js'), 'build', '--logLevel', 'warn'], { cwd: directory, stdio: 'inherit' });
      continue;
    }
    await cp(join('.build', group, name, 'src'), destination, { recursive: true });
  }
}
await rm('.build', { recursive: true, force: true });
