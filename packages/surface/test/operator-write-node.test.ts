import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { connectOpencode } from '../src/opencode.ts';

test('surface launcher pins its actual Node executable for the native OpenCode plugin', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'surface-host-node-'));
  const receipt = join(directory, 'environment.json');
  await writeFile(join(directory, 'opencode'), `#!${process.execPath}
const fs = require('node:fs');
fs.writeFileSync(${JSON.stringify(receipt)}, JSON.stringify({ node: process.env.ONIONSOUP_HOST_NODE }));
console.log('listening on http://127.0.0.1:43210');
setInterval(() => {}, 1000);
`, { mode: 0o700 });
  const originalPath = process.env.PATH;
  const originalNode = process.env.ONIONSOUP_HOST_NODE;
  let connection: Awaited<ReturnType<typeof connectOpencode>> | undefined;
  try {
    process.env.PATH = `${directory}:${dirname(process.execPath)}:/usr/bin:/bin`;
    process.env.ONIONSOUP_HOST_NODE = '/invalid/inherited/opencode';
    connection = await connectOpencode({});
    assert.equal(JSON.parse(await readFile(receipt, 'utf8')).node, process.execPath);
  } finally {
    connection?.close();
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    if (originalNode === undefined) delete process.env.ONIONSOUP_HOST_NODE;
    else process.env.ONIONSOUP_HOST_NODE = originalNode;
  }
});
