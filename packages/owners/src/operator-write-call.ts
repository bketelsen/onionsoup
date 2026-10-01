import { createHash, randomUUID } from 'node:crypto';

export const OPERATOR_WRITE_TOOL = 'onionsoup_operator_write_file';
export const OPERATOR_WRITE_CALL_LIMITS = { lifetimeMs: 60_000 };
const CAPABILITY = 'onionsoupWriteCall';
export interface OperatorFileInput { path: string; expectedBeforeSha256: string; content: string }
function digest(args: OperatorFileInput) {
  return createHash('sha256').update(JSON.stringify([args.path, args.expectedBeforeSha256, args.content])).digest('hex');
}

/** Native before-hook provenance, never a model-supplied call identity. */
export class OperatorWriteCalls {
  private readonly pending = new Map<string, { sessionID: string; callID: string; digest: string; expiresAt: number }>();

  prepare(input: { sessionID: string; callID: string }, args: Record<string, unknown>) {
    for (const [token, pending] of this.pending) if (pending.expiresAt <= Date.now()) this.pending.delete(token);
    const token = randomUUID();
    const values = args as unknown as OperatorFileInput;
    this.pending.set(token, { ...input, digest: digest(values), expiresAt: Date.now() + OPERATOR_WRITE_CALL_LIMITS.lifetimeMs });
    args[CAPABILITY] = token;
  }

  consume(sessionID: string, args: OperatorFileInput & Record<string, unknown>) {
    const token = args[CAPABILITY];
    delete args[CAPABILITY];
    if (typeof token !== 'string') throw new Error('operator_write_call_unbound');
    const pending = this.pending.get(token);
    this.pending.delete(token);
    if (!pending || pending.sessionID !== sessionID || pending.expiresAt <= Date.now() || pending.digest !== digest(args)) {
      throw new Error('operator_write_call_unbound');
    }
    return pending.callID;
  }
}
