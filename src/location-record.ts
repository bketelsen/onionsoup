import { z } from 'zod';
import { LocationInput, LocationBrief, SourcePath, isTestPath } from './location-contracts.ts';
import type { LocationRun } from './location-agent.ts';

const Excerpt = z.object({ id: z.string().regex(/^E[1-9][0-9]*$/), path: SourcePath, startLine: z.number().int().positive(),
  endLine: z.number().int().positive(), lines: z.array(z.string()).min(1).max(60) }).strict();
export function validateLocationRun(raw: unknown): LocationRun {
  const run = raw as LocationRun;
  if (!run || ![1, 2, 3].includes(run.schemaVersion) || run.agent !== 'code-location' || !z.string().uuid().safeParse(run.runId).success ||
      !['running', 'completed', 'failed'].includes(run.status) || !z.iso.datetime().safeParse(run.startedAt).success ||
      (run.status !== 'running' && !z.iso.datetime().safeParse(run.finishedAt).success) ||
      !/^[a-f0-9]{64}$/.test(run.runtimeHash) || !run.provider || !run.model || !run.promptVersion)
    throw new Error('Invalid code-location record');
  LocationInput.parse(run.input);
  const excerpts = z.array(Excerpt).max(12).parse(run.source?.excerpts);
  if (new Set(excerpts.map(e => e.id)).size !== excerpts.length || excerpts.some(e => e.endLine - e.startLine + 1 !== e.lines.length))
    throw new Error('Invalid saved source excerpts');
  if (run.status === 'completed') {
    const brief = LocationBrief.parse(run.brief);
    if (brief.schemaVersion !== run.schemaVersion) throw new Error('Run/brief version mismatch');
    if (!run.source.searchedTests || (brief.status === 'located' && !brief.codePointers.length) ||
        (brief.status === 'not_located' && (brief.codePointers.length || brief.testPointers.length))) throw new Error('Invalid brief outcome');
    for (const [pointers, tests] of [[brief.codePointers, false], [brief.testPointers, true]] as const) for (const c of pointers) {
      if (c.startLine > c.endLine || c.endLine - c.startLine + 1 > 30 || tests !== isTestPath(c.path) ||
        (c.symbol && !c.quote.includes(c.symbol)) || !excerpts.some(e => e.path === c.path && c.startLine >= e.startLine && c.endLine <= e.endLine &&
          e.lines.slice(c.startLine - e.startLine, c.endLine - e.startLine + 1).join('\n') === c.quote))
        throw new Error('Saved brief citation is not grounded in inspected source');
    }
  } else if (run.brief) throw new Error('Unfinished/failed location run contains brief');
  return run;
}
