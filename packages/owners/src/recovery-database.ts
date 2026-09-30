import { createRequire } from 'node:module';
type RecoveryDatabase = {
  prepare(sql: string): { get(...parameters: (string | number)[]): unknown; all(...parameters: (string | number)[]): unknown[] };
  exec(sql: string): unknown;
  close(): void;
};

/** OpenCode embeds Bun; the CLI and surface use Node. Both handles are strictly read-only. */
export function openRecoveryDatabase(path: string): RecoveryDatabase {
  const require = createRequire(import.meta.url);
  const isBun = !!process.versions.bun;
  // Resolve only the active runtime's builtin. Importing node:sqlite eagerly breaks OpenCode.
  const sqlite = isBun ? require('bun:sqlite') : require('node:sqlite');
  return isBun ? new sqlite.Database(path, { readonly: true, create: false })
    : new sqlite.DatabaseSync(path, { readOnly: true });
}
