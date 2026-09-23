import { execFile } from 'node:child_process';
import { cp, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { homeDirectory } from './paths.ts';

const run = promisify(execFile);

/** The starter declarations shipped with onionsoup: one example owner, freelancers, a workflow, rubrics. */
function starterDirectory() {
  return resolve(dirname(fileURLToPath(import.meta.url)), '../../../examples/starter');
}

/** Create a person's config directory from the starter, as its own Git repository. Never overwrites. */
export async function initConfig(directory: string) {
  if (existsSync(directory) && (await readdir(directory)).length) {
    console.log(`${directory} already exists and is not empty; nothing to do.`);
    return;
  }
  await cp(starterDirectory(), directory, { recursive: true });
  await run('git', ['init', '-q', directory]);
  await run('git', ['-C', directory, 'add', '-A']);
  await run('git', ['-C', directory, 'commit', '-q', '-m', 'Start from the onionsoup starter']).catch(() => undefined);
  console.log(`Created ${directory} from the onionsoup starter.
Next:
  1. Edit ${join(directory, 'owners/example.yaml')} (or copy it) and write the charter in ${join(directory, 'charters')}.
  2. Register the plugin in ~/.config/opencode/opencode.json: "plugin": ["file://<onionsoup>/packages/owners/src/plugin.ts"]
  3. npm run owners -- sync-openchamber   (creates each owner's desk and OpenChamber project)
  4. npm run owners -- daemon            (or install deploy/onionsoup-owners.service)
State will live in ${homeDirectory()}.`);
}
