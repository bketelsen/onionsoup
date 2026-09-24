import type { WorkItem } from '../types.ts';

/** Keep the reviewer's problem and proposed correction beside its severity and file. */
export function ReviewFindings({ verdict }: { verdict: WorkItem['verdicts'][number] }) {
  if (!verdict.findings.length) return null;
  return (
    <ul className="list-disc pl-5 typography-meta flex flex-col gap-2">
      {verdict.findings.map((finding, position) => (
        <li key={position}>
          <div>{`[${finding.severity}] `}{finding.file && `${finding.file}: `}{finding.issue}</div>
          {finding.suggestion && <div className="text-muted-foreground whitespace-pre-wrap">Suggestion: {finding.suggestion}</div>}
        </li>
      ))}
    </ul>
  );
}
