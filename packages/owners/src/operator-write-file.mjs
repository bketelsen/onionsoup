// Fixed host program. Model text is data over stdin; no shell, eval, child processes or arbitrary paths.
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
const INPUT_BYTES_LIMIT = 2 * 1024 * 1024;
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

async function readInput() {
  const chunks = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > INPUT_BYTES_LIMIT) throw new Error('operator_write_input_limit');
    chunks.push(chunk);
  }
  const input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  const content = Buffer.from(input.content, 'utf8');
  if (!Number.isSafeInteger(input.maxBytes) || input.maxBytes <= 0 || content.length > input.maxBytes
    || content.includes(0) || content.toString('utf8') !== input.content || sha256(content) !== input.afterSha256) throw new Error('operator_write_content_invalid');
  return { input, content };
}
async function writeContent(file, content) {
  let offset = 0;
  while (offset < content.length) {
    const written = await file.write(content, offset, content.length - offset, offset);
    if (!written.bytesWritten) throw new Error('operator_write_short_write');
    offset += written.bytesWritten;
  }
  await file.sync();
  const after = await file.stat();
  if (after.nlink !== 1 || after.size !== content.length) throw new Error('operator_write_after_changed');
  return after;
}
async function replaceExisting(input, content) {
  const file = await open('/tmp/operator-approved-file', constants.O_RDWR | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.dev !== input.device || stat.ino !== input.inode
      || stat.mode !== input.mode || stat.size > input.maxBytes) throw new Error('operator_write_identity_changed');
    if (input.birthtimeNs && (await file.stat({ bigint: true })).birthtimeNs.toString() !== input.birthtimeNs) throw new Error('operator_write_identity_changed');
    if (sha256(await file.readFile()) !== input.beforeSha256) throw new Error('operator_write_before_changed');
    await file.truncate(0);
    await writeContent(file, content);
    process.stdout.write('operator_write_applied\n');
  } finally { await file.close(); }
}
async function createNew(input, content) {
  if (typeof input.filename !== 'string' || !input.filename || /[\\/\0]/.test(input.filename)
    || ['.', '..', '.git'].includes(input.filename)) throw new Error('operator_write_filename_invalid');
  const parent = await open('/tmp/operator-approved-parent', constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    const identity = await parent.stat();
    if (identity.dev !== input.parent?.device || identity.ino !== input.parent?.inode) throw new Error('operator_write_parent_changed');
    const file = await open(`/proc/self/fd/${parent.fd}/${input.filename}`, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
    try {
      const stat = await writeContent(file, content);
      await parent.sync();
      const birthtimeNs = (await file.stat({ bigint: true })).birthtimeNs.toString();
      if (!/^[1-9][0-9]*$/.test(birthtimeNs)) throw new Error('operator_write_identity_unavailable');
      process.stdout.write(JSON.stringify({ path: input.path, sha256: sha256(content), bytes: content.length,
        mode: stat.mode, device: stat.dev, inode: stat.ino, links: stat.nlink, kind: 'file', birthtimeNs }));
    } finally { await file.close(); }
  } finally { await parent.close(); }
}
const { input, content } = await readInput();
const writers = { absent: createNew };
const write = writers[input.beforeSha256] ?? replaceExisting;
await write(input, content);
