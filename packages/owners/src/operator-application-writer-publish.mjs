// Fixed host publisher. Approved paths and bytes are data; stdin requires an explicit permit, never EOF.
import { constants } from 'node:fs';
import { link, open, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const FILE_BYTES_LIMIT = 256n * 1024n;

await new Promise((resolve, reject) => {
  process.stdin.once('data', chunk => {
    if (chunk.length !== 1 || chunk[0] !== 1) reject(new Error('operator_application_permit_invalid'));
    else { process.stdin.destroy(); resolve(); }
  });
  process.stdin.once('end', () => reject(new Error('operator_application_permit_missing')));
  process.stdin.once('error', () => reject(new Error('operator_application_permit_missing')));
  process.stdin.resume();
});
const intent = JSON.parse(await readFile('/runtime/intent.json', 'utf8'));
const name = path => {
  const value = path.split('/').at(-1);
  if (!value || /[\\\0]/.test(value) || ['.', '..', '.git'].includes(value)) throw new Error('operator_application_name_invalid');
  return value;
};
async function inspect(file, expected, links) {
  const metadata = await file.stat({ bigint: true });
  if (!metadata.isFile() || metadata.dev.toString() !== String(expected.device)
    || metadata.ino.toString() !== String(expected.inode) || Number(metadata.mode) !== expected.mode
    || metadata.birthtimeNs.toString() !== expected.birthtimeNs || Number(metadata.nlink) !== links
    || metadata.size > FILE_BYTES_LIMIT) throw new Error('operator_application_identity_changed');
  return metadata;
}
const creating = intent.before === 'absent';
const stagePath = creating ? `/target-parent/${name(intent.stage.path)}` : '/stage';
const staged = await open(stagePath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
try {
  await inspect(staged, intent.stage, 1);
  const bytes = await staged.readFile();
  if (bytes.length !== intent.stage.bytes || sha256(bytes) !== intent.mutation.afterSha256) throw new Error('operator_application_stage_changed');
  if (creating) {
    const parent = await open('/target-parent', constants.O_RDONLY | constants.O_DIRECTORY);
    try {
      const metadata = await parent.stat();
      const expected = intent.parents.find(parent => parent.path === intent.mutation.path.split('/').slice(0, -1).join('/'));
      if (metadata.dev !== expected.device || metadata.ino !== expected.inode) throw new Error('operator_application_parent_changed');
      await link(stagePath, `/target-parent/${name(intent.mutation.path)}`);
      await parent.sync();
    } finally { await parent.close(); }
  } else {
    const target = await open('/target', constants.O_RDWR | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      await inspect(target, intent.before, 1);
      if (sha256(await target.readFile()) !== intent.mutation.beforeSha256) throw new Error('operator_application_before_changed');
      await target.truncate(0);
      let offset = 0;
      while (offset < bytes.length) {
        const written = await target.write(bytes, offset, bytes.length - offset, offset);
        if (!written.bytesWritten) throw new Error('operator_application_short_write');
        offset += written.bytesWritten;
      }
      await target.sync();
      await inspect(target, intent.before, 1);
    } finally { await target.close(); }
  }
  process.stdout.write('operator_application_published\n');
} finally { await staged.close(); }
