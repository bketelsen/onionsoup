import { z } from 'zod';
import { IssueSnapshot } from './contracts.ts';
import { githubSource, type Source } from './inbox-source.ts';

export const BriefingIntake = z.object({ capturedAt: z.iso.datetime(),
  method: z.enum(['recently_updated_open', 'explicit_issues']), requestedCount: z.number().int().min(1).max(5),
  scannedEntries: z.number().int().nonnegative(), windowFull: z.boolean(),
  issues: z.array(z.object({ snapshot: IssueSnapshot, state: z.enum(['open', 'closed']),
    observedAt: z.iso.datetime(), commentsExcluded: z.number().int().nonnegative() }).strict()).max(5),
  rejected: z.array(z.object({ number: z.number().int().positive(), reason: z.enum(['invalid_snapshot', 'unavailable']) }).strict()).max(100),
}).strict();
export type BriefingIntake = z.infer<typeof BriefingIntake>;
export async function captureBriefingIssues(repository: string, options: {
  count: number; issueNumbers?: number[]; signal: AbortSignal; source?: Source;
}): Promise<BriefingIntake> {
  IssueSnapshot.shape.repository.parse(repository);
  z.number().int().min(1).max(5).parse(options.count);
  const numbers = options.issueNumbers;
  if (numbers && (!numbers.length || numbers.length > options.count || new Set(numbers).size !== numbers.length ||
      numbers.some(n => !Number.isSafeInteger(n) || n < 1))) throw new Error('Invalid explicit issue selection');
  const source = options.source ?? githubSource;
  const intake: BriefingIntake = { capturedAt: new Date().toISOString(), method: numbers ? 'explicit_issues' : 'recently_updated_open',
    requestedCount: numbers?.length ?? options.count, scannedEntries: 0, windowFull: false, issues: [], rejected: [] };
  const add = (item: Awaited<ReturnType<Source['get']>>) => {
    if (!item.snapshot) intake.rejected.push({ number: item.number, reason: 'invalid_snapshot' });
    else {
      const snapshot = IssueSnapshot.parse(item.snapshot);
      if (snapshot.repository !== repository || snapshot.number !== item.number) throw new Error('Intake identity mismatch');
      intake.issues.push({ snapshot, state: item.state, observedAt: item.observedAt, commentsExcluded: item.commentsExcluded });
    }
  };
  if (numbers) {
    for (const number of numbers) {
      options.signal.throwIfAborted();
      try {
        const item = await source.get(repository, number, options.signal);
        if (item.number !== number) throw new Error('Intake identity mismatch');
        add(item); intake.scannedEntries++;
      } catch {
        options.signal.throwIfAborted();
        intake.rejected.push({ number, reason: 'unavailable' });
      }
    }
  } else {
    const scan = await source.scan(repository, 1, options.signal);
    intake.scannedEntries = scan.entries; intake.windowFull = scan.windowFull;
    const seen = new Set<number>();
    for (const item of [...scan.observations].sort((a,b) => b.updatedAt.localeCompare(a.updatedAt) || b.number - a.number)) {
      if (item.state !== 'open' || seen.has(item.number)) continue;
      seen.add(item.number); add(item);
      if (intake.issues.length === options.count) break;
    }
  }
  return BriefingIntake.parse(intake);
}
