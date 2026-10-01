import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fingerprintEvidence } from './maintenance-admission-probe.mjs';
import { backupMaintenanceEvidence } from './maintenance-recovery-storage.mjs';

async function fixture(context) {
  const scratch = await mkdtemp(join(tmpdir(), 'maintenance-backup-'));
  context.after(() => rm(scratch, { recursive: true, force: true }));
  const selection = { state: join(scratch, 'state'), config: join(scratch, 'config'), evidenceRoots: [join(scratch, 'opencode')] };
  for (const path of [selection.state, selection.config, ...selection.evidenceRoots]) await mkdir(path);
  await writeFile(join(selection.state, 'item.json'), '{"outcome":"unknown"}');
  return { scratch, selection, async proof() { return { selection, evidence: await fingerprintEvidence(selection) }; } };
}

test('online SQLite backup retains committed WAL history and is verified on reuse without touching original records', async context => {
  const setup = await fixture(context);
  const databasePath = join(setup.selection.evidenceRoots[0], 'opencode.db');
  const database = new DatabaseSync(databasePath);
  context.after(() => database.close());
  database.exec('PRAGMA journal_mode=WAL; CREATE TABLE history (message TEXT); INSERT INTO history VALUES (\'preserved unknown outcome\')');
  const proof = await setup.proof();
  const directory = join(setup.scratch, 'backup');
  const receipt = await backupMaintenanceEvidence(proof, directory);
  const copied = receipt.copies.flatMap(copy => copy.databases);
  assert.equal(copied.length, 1);
  const snapshot = new DatabaseSync(copied[0].copy, { readOnly: true });
  assert.equal(snapshot.prepare('SELECT message FROM history').get().message, 'preserved unknown outcome');
  snapshot.close();
  assert.deepEqual(await backupMaintenanceEvidence(proof, directory), receipt);
  assert.equal(await readFile(join(setup.selection.state, 'item.json'), 'utf8'), '{"outcome":"unknown"}');
  await writeFile(copied[0].copy, 'corruption');
  await assert.rejects(backupMaintenanceEvidence(proof, directory), /backup_database_changed/);
});

test('post-interruption copy records changed outcomes without claiming original equality and rejects tampered reuse', async context => {
  const setup = await fixture(context);
  const proof = await setup.proof();
  await writeFile(join(setup.selection.state, 'item.json'), '{"outcome":"still unknown","receipt":"late"}');
  const directory = join(setup.scratch, 'after');
  const receipt = await backupMaintenanceEvidence(proof, directory, false);
  assert.equal(receipt.verifiedOriginal, false);
  const copy = receipt.copies.find(copy => copy.source === setup.selection.state);
  assert.match(await readFile(join(copy.destination, 'item.json'), 'utf8'), /late/);
  assert.deepEqual(await backupMaintenanceEvidence(proof, directory, false, true), receipt);
  await writeFile(join(copy.destination, 'item.json'), '{}');
  await assert.rejects(backupMaintenanceEvidence(proof, directory, false, true), /backup_changed/);
});

test('required missing archives and changed approved bytes refuse instead of inventing a replacement backup', async context => {
  const setup = await fixture(context);
  const proof = await setup.proof();
  await assert.rejects(backupMaintenanceEvidence(proof, join(setup.scratch, 'missing'), false, true), /backup_missing/);
  await writeFile(join(setup.selection.state, 'item.json'), '{}');
  await assert.rejects(backupMaintenanceEvidence(proof, join(setup.scratch, 'changed')), /backup_evidence_changed/);
});
