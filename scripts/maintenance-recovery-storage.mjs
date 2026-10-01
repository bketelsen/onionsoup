import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { cp, link, lstat, mkdir, open, readFile, readdir, readlink, rename, rm, symlink } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { z } from 'zod';
import { fail, hash } from './admission-recovery-proof.mjs';

const exec = promisify(execFile);
const BackupReceipt = z.object({ version: z.literal(1), proofDigest: z.string(), verifiedOriginal: z.boolean(),
  contentsDigest: z.string().regex(/^[a-f0-9]{64}$/),
  copies: z.array(z.object({ source: z.string(), destination: z.string(),
    databases: z.array(z.object({ source: z.string(), copy: z.string(), digest: z.string() }).strict()) }).strict()),
  at: z.iso.datetime() }).strict();
export async function optionalRecord(path, schema) {
  const bytes = await readFile(path, 'utf8').catch(error => {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  });
  return bytes === undefined ? undefined : schema.parse(JSON.parse(bytes));
}

export async function durableExclusive(path, value) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  const file = await open(temporary, 'wx', 0o600);
  try {
    await file.writeFile(JSON.stringify(value) + '\n');
    await file.sync();
  } finally { await file.close(); }
  try {
    await link(temporary, path);
    const directory = await open(dirname(path), 'r');
    try { await directory.sync(); } finally { await directory.close(); }
  } finally { await rm(temporary, { force: true }); }
}

export async function switchPointer(pointer, target) {
  const temporary = `${pointer}.${randomUUID()}.tmp`;
  try {
    await symlink(target, temporary);
    await rename(temporary, pointer);
    const directory = await open(dirname(pointer), 'r');
    try { await directory.sync(); } finally { await directory.close(); }
  } finally { await rm(temporary, { force: true }); }
}

async function sqliteFiles(directory) {
  const paths = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) paths.push(...await sqliteFiles(path));
    else if (entry.isFile()) {
      const file = await open(path, 'r');
      try {
        const header = Buffer.alloc(16);
        await file.read(header, 0, 16, 0);
        if (header.equals(Buffer.from('SQLite format 3\0'))) paths.push(path);
      } finally { await file.close(); }
    }
  }
  return paths;
}

const SQLITE_BACKUP = `import sqlite3, sys
from pathlib import Path
source = sqlite3.connect(Path(sys.argv[1]).as_uri() + '?mode=ro', uri=True, timeout=5)
target = sqlite3.connect(sys.argv[2])
source.backup(target)
assert target.execute('pragma quick_check').fetchone()[0] == 'ok'
target.close()
source.close()
`;

async function syncTree(path) {
  const metadata = await lstat(path);
  if (metadata.isSymbolicLink()) return;
  if (metadata.isDirectory()) {
    for (const name of await readdir(path)) await syncTree(join(path, name));
  }
  const file = await open(path, 'r');
  try { await file.sync(); } finally { await file.close(); }
}

async function verifyCopies(proof, copies) {
  for (const entry of proof.evidence.entries) {
    if (entry.type === 'absent') continue;
    const copy = copies.find(copy => copy.source === entry.root);
    if (!copy) throw fail('maintenance_recovery_backup_incomplete');
    const path = join(copy.destination, entry.path);
    const metadata = await lstat(path);
    const type = metadata.isSymbolicLink() ? 'symlink' : metadata.isDirectory() ? 'directory' : 'file';
    const contents = type === 'directory' ? 'directory' : type === 'symlink' ? await readlink(path) : await readFile(path);
    const sha256 = createHash('sha256').update(contents).digest('hex');
    if (type !== entry.type || sha256 !== entry.sha256 || (entry.mode !== undefined && (metadata.mode & 0o7777) !== entry.mode)) {
      throw fail('maintenance_recovery_backup_evidence_changed');
    }
  }
}

async function copiesDigest(copies) {
  const entries = [];
  async function walk(path) {
    const metadata = await lstat(path);
    const type = metadata.isSymbolicLink() ? 'symlink' : metadata.isDirectory() ? 'directory' : 'file';
    const contents = type === 'directory' ? 'directory' : type === 'symlink' ? await readlink(path) : await readFile(path);
    entries.push({ path, type, mode: metadata.mode & 0o7777,
      digest: createHash('sha256').update(contents).digest('hex') });
    if (type === 'directory') for (const name of (await readdir(path)).sort()) await walk(join(path, name));
  }
  for (const copy of copies) {
    await walk(copy.destination);
    for (const database of copy.databases) {
      if (hash(await readFile(database.copy)) !== database.digest) throw fail('maintenance_recovery_backup_database_changed');
      await walk(database.copy);
    }
  }
  return hash(entries);
}

/** Raw copies preserve evidence; separate online SQLite copies provide consistent database snapshots. */
export async function backupMaintenanceEvidence(proof, directory, verifyOriginal = true, requireExisting = false) {
  const roots = [...new Set(proof.evidence.entries.filter(entry => entry.type !== 'absent').map(entry => entry.root))];
  if (roots.some(root => directory === root || directory.startsWith(root + sep))) {
    throw fail('maintenance_recovery_backup_inside_evidence');
  }
  const existing = await optionalRecord(join(directory, 'backup.json'), BackupReceipt);
  if (existing) {
    if (existing.proofDigest !== hash(proof) || existing.verifiedOriginal !== verifyOriginal
      || hash(existing.copies.map(copy => copy.source).sort()) !== hash([...roots].sort())
      || existing.copies.some(copy => !copy.destination.startsWith(directory + sep))) {
      throw fail('maintenance_recovery_backup_invalid');
    }
    if (verifyOriginal) await verifyCopies(proof, existing.copies);
    if (await copiesDigest(existing.copies) !== existing.contentsDigest) throw fail('maintenance_recovery_backup_changed');
    return existing;
  }
  if (requireExisting) throw fail('maintenance_recovery_backup_missing');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const attemptDirectory = join(directory, randomUUID());
  await mkdir(attemptDirectory, { mode: 0o700 });
  const copies = [];
  for (const [index, source] of roots.entries()) {
    if (!(await lstat(source)).isDirectory()) throw fail('maintenance_recovery_backup_root_invalid');
    const destination = join(attemptDirectory, String(index));
    await cp(source, destination, { recursive: true, dereference: false, verbatimSymlinks: true,
      filter: path => !path.endsWith('.lock') && !path.endsWith('.sock') });
    const databases = [];
    for (const database of await sqliteFiles(source)) {
      const consistent = join(attemptDirectory, `${index}-${hash(database)}.sqlite`);
      await exec('python3', ['-c', SQLITE_BACKUP, database, consistent], { timeout: 60_000 });
      databases.push({ source: database, copy: consistent, digest: hash(await readFile(consistent)) });
    }
    copies.push({ source: resolve(source), destination, databases });
  }
  if (verifyOriginal) await verifyCopies(proof, copies);
  await syncTree(attemptDirectory);
  const receipt = { version: 1, proofDigest: hash(proof), verifiedOriginal: verifyOriginal,
    contentsDigest: await copiesDigest(copies), copies, at: new Date().toISOString() };
  await durableExclusive(join(directory, 'backup.json'), receipt);
  return receipt;
}
