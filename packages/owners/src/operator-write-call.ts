import { createHash, randomUUID } from 'node:crypto';

export const OPERATOR_WRITE_TOOL = 'onionsoup_operator_write_file';
export const OPERATOR_CHECK_TOOL = 'onionsoup_operator_check';
export const OPERATOR_WRITE_CALL_LIMITS = { lifetimeMs: 60_000 };
export interface OperatorFileInput { path: string; expectedBeforeSha256: string; content: string }
function fileDigest(args: OperatorFileInput) {
  return createHash('sha256').update(JSON.stringify([args.path, args.expectedBeforeSha256, args.content])).digest('hex');
}

/** Native before-hook provenance, never a model-supplied call identity. */
class OperatorCalls<Input extends object> {
  constructor(private readonly capability: string, private readonly digest: (args: Input) => string) {}
  private readonly pending = new Map<string, { sessionID: string; callID: string; digest: string; expiresAt: number }>();

  prepare(input: { sessionID: string; callID: string }, args: Record<string, unknown>) {
    for (const [token, pending] of this.pending) if (pending.expiresAt <= Date.now()) this.pending.delete(token);
    const token = randomUUID();
    const values = args as Input;
    this.pending.set(token, { ...input, digest: this.digest(values), expiresAt: Date.now() + OPERATOR_WRITE_CALL_LIMITS.lifetimeMs });
    args[this.capability] = token;
  }

  consume(sessionID: string, args: Input & Record<string, unknown>) {
    const token = args[this.capability];
    delete args[this.capability];
    if (typeof token !== 'string') throw new Error('operator_write_call_unbound');
    const pending = this.pending.get(token);
    this.pending.delete(token);
    if (!pending || pending.sessionID !== sessionID || pending.expiresAt <= Date.now() || pending.digest !== this.digest(args)) {
      throw new Error('operator_write_call_unbound');
    }
    return pending.callID;
  }
}

export class OperatorWriteCalls extends OperatorCalls<OperatorFileInput> {
  constructor() { super('onionsoupWriteCall', fileDigest); }
}

export interface OperatorCheckInput { checkID: string }
export class OperatorCheckCalls extends OperatorCalls<OperatorCheckInput> {
  constructor() { super('onionsoupCheckCall', args => createHash('sha256').update(JSON.stringify([args.checkID])).digest('hex')); }
}
