import { useState } from 'react';
import type { InboxEntry } from '../types.ts';
import { navigate } from '../api.ts';
import { Button } from './ui.tsx';

export function AttentionAssignment({ entry, busy, decide }: {
  entry: InboxEntry; busy: boolean; decide: (action: string, extra?: Record<string, unknown>) => Promise<void>;
}) {
  const [expanded, setExpanded] = useState(false);
  const [target, setTarget] = useState('');
  const [title, setTitle] = useState('');
  const [goal, setGoal] = useState('');
  const [criteria, setCriteria] = useState('');
  const assignment = entry.attentionAssignment;
  if (assignment) return <div className="typography-meta whitespace-pre-wrap">
    Assigned by {assignment.by} to {assignment.owner}: {assignment.status === 'pending-owner' ? 'awaiting owner acceptance' : assignment.status}.
    <div className="font-mono break-all">{assignment.requestID}</div>
    {assignment.reason && <div>{assignment.reason}</div>}
    {assignment.status === 'blocked' && <Button disabled={busy} onClick={() => void decide('retry-attention-assignment')}>Retry assignment</Button>}
    {assignment.workItem && <Button variant="ghost" onClick={() => navigate('item', assignment.workItem!)}>View linked work</Button>}
    <div>This remains unresolved until its outcome is verified.</div>
  </div>;
  const options = entry.assignmentTargets ?? [];
  if (!options.length) return <div className="typography-meta">No configured repository owner can accept assignment.</div>;
  if (!expanded) return <Button disabled={busy} onClick={() => setExpanded(true)}>Assign repository fix</Button>;
  const selected = options.find(option => `${option.owner}:${option.repository}` === target);
  const acceptance = criteria.split('\n').map(line => line.trim()).filter(Boolean);
  const canAssign = selected && title.trim() && goal.trim() && acceptance.length;
  const fieldClass = 'rounded border border-border bg-background px-2 py-1 typography-meta';
  return <fieldset disabled={busy} className="flex flex-col gap-2 border border-border rounded p-2">
    <legend className="typography-meta">Assign a concrete repository fix</legend>
    <select aria-label="Assignment owner and repository" value={target} onChange={event => setTarget(event.target.value)} className={fieldClass}>
      <option value="">Choose owner / repository</option>
      {options.map(option => <option key={`${option.owner}:${option.repository}`} value={`${option.owner}:${option.repository}`}>{option.owner} / {option.repository}</option>)}
    </select>
    <input aria-label="Assignment title" placeholder="Title" value={title} onChange={event => setTitle(event.target.value)} className={fieldClass} />
    <textarea aria-label="Assignment goal" placeholder="What outcome do you want?" value={goal} onChange={event => setGoal(event.target.value)} className={fieldClass} />
    <textarea aria-label="Assignment acceptance criteria" placeholder="What proves it is fixed? One criterion per line" value={criteria} onChange={event => setCriteria(event.target.value)} className={fieldClass} />
    <div className="typography-meta text-muted-foreground">The owner accepts or declines, then proposes a plan under existing approval rules. This does not authorize publication or deployment.</div>
    <Button variant="primary" disabled={busy || !canAssign} onClick={() => {
      if (selected) void decide('assign-attention', { assignment: { ...selected, title, goal, acceptance } });
    }}>Assign fix</Button>
  </fieldset>;
}
