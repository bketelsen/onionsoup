import { cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';
const destination = resolve('dist/repository-brief');
await rm(destination, { recursive: true, force: true });
await mkdir(destination, { recursive: true });
const root = JSON.parse(await readFile('package.json', 'utf8'));
// Exact workspace/dependency graph matches the lock. No legacy source, tests, runs or credentials.
root.scripts = { brief: 'node apps/brief-cli/dist/main.js', worker: 'node apps/brief-worker/dist/main.js',
  mcp: 'node apps/brief-mcp/dist/main.js', 'mail-capture': 'node apps/mail-capture/dist/main.js', verify: 'node verify-release.mjs' };
await writeFile(join(destination, 'package.json'), JSON.stringify(root, null, 2) + '\n');
await cp('package-lock.json', join(destination, 'package-lock.json'));
for (const group of ['packages', 'apps']) for (const name of await readdir(group)) {
  const source = join(group, name), target = join(destination, source);
  await mkdir(target, { recursive: true });
  const manifest = JSON.parse(await readFile(join(source, 'package.json'), 'utf8'));
  for (const entry of Object.values(manifest.exports)) {
    delete entry['onionsoup-source']; entry.types = entry.default.replace(/\.js$/, '.d.ts');
  }
  await writeFile(join(target, 'package.json'), JSON.stringify(manifest, null, 2) + '\n');
  await cp(join(source, 'dist'), join(target, 'dist'), { recursive: true });
}
await cp('scripts/verify-release.mjs', join(destination, 'verify-release.mjs'));
const files = {};
async function inventory(directory, prefix = '') {
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a,b) => a.name.localeCompare(b.name))) {
    const path = join(directory, entry.name), key = prefix + entry.name;
    if (entry.isDirectory()) await inventory(path, key + '/');
    else files[key] = createHash('sha256').update(await readFile(path)).digest('hex');
  }
}
await inventory(destination);
const revision = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const dirty = Boolean(execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim());
await writeFile(join(destination, 'release.json'), JSON.stringify({ schemaVersion: 1, application: 'repository-brief',
  version: root.version, source: { revision, dirty }, node: process.version, files }, null, 2) + '\n');
console.log(`Release: ${destination} (${Object.keys(files).length} files). Install with npm ci --omit=dev --ignore-scripts.`);
