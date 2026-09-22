<script lang="ts">
  import { shortCommit, stamp } from '../format.ts';

  type Approval = {
    origin: 'proposal' | 'request'; proposalJobId?: string; repository: string; baseCommit: string; reason: string; approvedAt: string;
    task: { title: string; request: string; allowedFiles: string[]; context: { path: string; startLine: number; endLine: number }[] };
  };
  let { result }: { result: unknown } = $props();
  const approval = $derived((result as { approval: Approval }).approval);
  const blob = (path: string, start: number, end: number) => `https://github.com/${approval.repository}/blob/${approval.baseCommit}/${path}#L${start}-L${end}`;
</script>

<p>
  <strong>{approval.task.title}</strong>
  <span class="tag">{approval.origin === 'request' ? 'typed request' : 'from a proposal'}</span>
</p>
<p class="muted">
  {approval.repository} at <a href={`https://github.com/${approval.repository}/commit/${approval.baseCommit}`} target="_blank" rel="noopener noreferrer"><code>{shortCommit(approval.baseCommit)}</code></a>
  · approved {stamp(approval.approvedAt)}
  {#if approval.proposalJobId}{' '}· <a href={`#/jobs/${approval.proposalJobId}`}>proposal</a>{/if}
</p>
<p><strong>Reason:</strong> {approval.reason}</p>

<h3>Files the agents may edit</h3>
<ul>{#each approval.task.allowedFiles as file}<li><code>{file}</code></li>{/each}</ul>

<details>
  <summary>Request the agents will read</summary>
  <p class="request">{approval.task.request}</p>
</details>
{#if approval.task.context.length}
  <details>
    <summary>Source context ({approval.task.context.length} excerpts)</summary>
    <ul>{#each approval.task.context as excerpt}<li><a href={blob(excerpt.path, excerpt.startLine, excerpt.endLine)} target="_blank" rel="noopener noreferrer"><code>{excerpt.path}:{excerpt.startLine}–{excerpt.endLine}</code></a></li>{/each}</ul>
  </details>
{/if}

<style>
  h3 { font-size: 0.95rem; margin: 1rem 0 0.4rem; }
  .request { white-space: pre-wrap; }
</style>
