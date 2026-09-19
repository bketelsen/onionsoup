import { readFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
const root = fileURLToPath(new URL('.', import.meta.url));
const release = JSON.parse(await readFile(join(root, 'release.json'), 'utf8'));
if (release.schemaVersion !== 1 || release.application !== 'repository-brief') throw new Error('Unknown release format');
const actual = {};
async function scan(directory, prefix = '') {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || !prefix && entry.name === 'release.json') continue;
    const key = prefix + entry.name, path = join(directory, entry.name);
    if (entry.isDirectory()) await scan(path, key + '/');
    else if (entry.isFile()) actual[key] = createHash('sha256').update(await readFile(path)).digest('hex');
    else throw new Error(`Unexpected release entry: ${key}`);
  }
}
await scan(root);
if (Object.keys(actual).length !== Object.keys(release.files).length || Object.entries(release.files).some(([path, digest]) => actual[path] !== digest))
  throw new Error('Release inventory mismatch');
console.log(`Verified ${Object.keys(actual).length} release files; dependency versions are pinned by package-lock.json.`);
