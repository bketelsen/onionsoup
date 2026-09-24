import type { ReactNode } from 'react';
import { RiExternalLinkLine } from '@remixicon/react';
import { navigate } from '../api.ts';
import type { InboxEntry } from '../types.ts';
import { Button } from './ui.tsx';

export interface DecisionActionProps {
  entry: InboxEntry;
  busy: boolean;
  text: string;
  withDelete: boolean;
  setWithDelete: (value: boolean) => void;
  decide: (action: string, extra?: Record<string, unknown>) => Promise<void>;
  permission: (reply: 'once' | 'always' | 'reject') => Promise<void>;
}

function PlanActions(props: DecisionActionProps) {
  const { entry, busy, text, decide } = props;
  return <>
    <Button variant="primary" disabled={busy} onClick={() => void decide('approve-plan', { note: text || undefined })}>Approve plan</Button>
    <Button disabled={busy || !text.trim()} onClick={() => void decide('revise-plan', { note: text })}>Send back</Button>
    <Button variant="destructive" disabled={busy || !text.trim()} onClick={() => void decide('reject-plan', { reason: text })}>Reject</Button>
    <ItemLink entry={entry} label="Full plan" />
  </>;
}

function PushActions(props: DecisionActionProps) {
  const { busy, text, decide } = props;
  return <>
    <Button variant="primary" disabled={busy} onClick={() => void decide('approve-push')}>Approve force-push</Button>
    <Button variant="destructive" disabled={busy || !text.trim()}
      onClick={() => void decide('cancel-item', { reason: text.trim() })}>Decline force-push</Button>
  </>;
}

function PublishActions(props: DecisionActionProps) {
  const { entry, busy, decide } = props;
  return <>
    <Button variant="primary" disabled={busy} onClick={() => void decide('publish')}>Publish draft PR</Button>
    <ItemLink entry={entry} label="Details" />
  </>;
}

function CreateActions(props: DecisionActionProps) {
  const { busy, text, withDelete, setWithDelete, decide } = props;
  return <>
    <label className="inline-flex items-center gap-1 typography-meta text-muted-foreground">
      <input type="checkbox" checked={withDelete} disabled={busy} onChange={event => setWithDelete(event.target.checked)} />
      also delete when done
    </label>
    <Button variant="primary" disabled={busy} onClick={() => void decide('approve-create', { withDelete })}>Approve create</Button>
    <Button variant="destructive" disabled={busy} onClick={() => void decide('deny-request', { reason: text || undefined })}>Deny</Button>
  </>;
}

function DeleteActions(props: DecisionActionProps) {
  const { busy, text, decide } = props;
  return <>
    <Button variant="primary" disabled={busy} onClick={() => void decide('approve-delete')}>Approve delete</Button>
    <Button disabled={busy} onClick={() => void decide('deny-request', { reason: text || 'keep it' })}>Keep it</Button>
  </>;
}

function PermissionActions(props: DecisionActionProps) {
  const { busy, permission } = props;
  return <>
    <Button variant="primary" disabled={busy} onClick={() => void permission('once')}>Allow once</Button>
    <Button disabled={busy} onClick={() => void permission('always')}>Always</Button>
    <Button variant="destructive" disabled={busy} onClick={() => void permission('reject')}>Reject</Button>
  </>;
}

function AttentionActions(props: DecisionActionProps) {
  const { entry, busy, text, decide } = props;
  return <>
    {entry.attentionStatus !== 'acknowledged' && <Button disabled={busy || !text.trim()}
      onClick={() => void decide('acknowledge-attention', { reason: text })}>Acknowledge</Button>}
    <Button variant="primary" disabled={busy || !text.trim()}
      onClick={() => void decide('resolve-attention', { reason: text })}>Resolve</Button>
  </>;
}

function RecoveryActions(props: DecisionActionProps) {
  const { busy, text, decide } = props;
  return <>
    <Button disabled={busy} onClick={() => void decide('reconcile-request')}>Check outcome</Button>
    <Button variant="primary" disabled={busy || !text.trim()}
      onClick={() => void decide('retry-request', { reason: text })}>Retry after inspection</Button>
    <Button variant="destructive" disabled={busy || !text.trim()}
      onClick={() => void decide('cancel-request', { reason: text })}>Stop request</Button>
  </>;
}

function ItemLink({ entry, label }: { entry: InboxEntry; label: string }) {
  if (globalThis.location?.hash.startsWith('#/item/')) return null;
  return <Button variant="ghost" onClick={() => navigate('item', entry.id)}>
    <RiExternalLinkLine className="size-3.5" />{label}
  </Button>;
}

const ACTIONS: Record<InboxEntry['kind'], (props: DecisionActionProps) => ReactNode> = {
  plan: PlanActions,
  push: PushActions,
  publish: PublishActions,
  create: CreateActions,
  delete: DeleteActions,
  permission: PermissionActions,
  attention: AttentionActions,
  'request-recovery': RecoveryActions,
  question: () => null,
};

export function DecisionActions(props: DecisionActionProps) {
  const Actions = ACTIONS[props.entry.kind];
  return <Actions {...props} />;
}
