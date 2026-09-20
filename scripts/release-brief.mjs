import { cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';
const destination = resolve('dist/repository-brief');
await rm(destination, { recursive: true, force: true });
await mkdir(destination, { recursive: true });
const root = JSON.parse(await readFile('package.json', 'utf8'));
// Include only these apps and their declared workspace dependencies, never unrelated hosts.
const workspaces = new Map();
for (const group of ['packages', 'apps']) for (const name of await readdir(group)) {
  const directory = `${group}/${name}`;
  const manifest = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'));
  workspaces.set(manifest.name, { directory, manifest });
}
const selected = new Map();
function select(name) {
  if (selected.has(name)) return;
  const workspace = workspaces.get(name);
  if (!workspace) throw new Error(`Unknown workspace: ${name}`);
  selected.set(name, workspace);
  for (const dependency of Object.keys(workspace.manifest.dependencies ?? {}))
    if (dependency.startsWith('@onionsoup/')) select(dependency);
}
for (const name of ['brief-cli', 'brief-worker', 'brief-mcp', 'mail-capture']) select(`@onionsoup/${name}-app`);
root.workspaces = [...selected.values()].map(workspace => workspace.directory).sort();
root.scripts = { brief: 'node apps/brief-cli/dist/main.js', worker: 'node apps/brief-worker/dist/main.js',
  mcp: 'node apps/brief-mcp/dist/main.js', 'mail-capture': 'node apps/mail-capture/dist/main.js', verify: 'node verify-release.mjs' };
await writeFile(join(destination, 'package.json'), JSON.stringify(root, null, 2) + '\n');
const lock = JSON.parse(await readFile('package-lock.json', 'utf8'));
lock.packages[''].workspaces = root.workspaces;
for (const [name, workspace] of workspaces) if (!selected.has(name)) {
  delete lock.packages[workspace.directory]; delete lock.packages[`node_modules/${name}`];
}
await writeFile(join(destination, 'package-lock.json'), JSON.stringify(lock, null, 2) + '\n');
for (const { directory: source, manifest } of selected.values()) {
  const target = join(destination, source);
  await mkdir(target, { recursive: true });
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
