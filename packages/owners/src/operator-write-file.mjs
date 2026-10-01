// Fixed host program. Model text is data over stdin; no shell, eval, child processes or arbitrary paths.
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
const INPUT_BYTES_LIMIT = 2 * 1024 * 1024;
const chunks = [];
let size = 0;
for await (const chunk of process.stdin) {
  size += chunk.length;
  if (size > INPUT_BYTES_LIMIT) throw new Error('operator_write_input_limit');
  chunks.push(chunk);
}
const input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const content = Buffer.from(input.content, 'utf8');
if (!Number.isSafeInteger(input.maxBytes) || input.maxBytes <= 0 || content.length > input.maxBytes
  || content.includes(0) || content.toString('utf8') !== input.content || sha256(content) !== input.afterSha256) throw new Error('operator_write_content_invalid');
const file = await open('/tmp/operator-approved-file', constants.O_RDWR | constants.O_NOFOLLOW);
try {
  const stat = await file.stat();
  if (!stat.isFile() || stat.nlink !== 1 || stat.dev !== input.device || stat.ino !== input.inode
    || stat.mode !== input.mode || stat.size > input.maxBytes) throw new Error('operator_write_identity_changed');
  const before = await file.readFile();
  if (sha256(before) !== input.beforeSha256) throw new Error('operator_write_before_changed');
  // The only writable host inode is this already-open, approved file. Partial failures stay uncertain.
  await file.truncate(0);
  let offset = 0;
  while (offset < content.length) {
    const written = await file.write(content, offset, content.length - offset, offset);
    if (!written.bytesWritten) throw new Error('operator_write_short_write');
    offset += written.bytesWritten;
  }
  await file.sync();
  const after = await file.stat();
  if (after.nlink !== 1 || after.size !== content.length) throw new Error('operator_write_after_changed');
  process.stdout.write('operator_write_applied\n');
} finally { await file.close(); }
