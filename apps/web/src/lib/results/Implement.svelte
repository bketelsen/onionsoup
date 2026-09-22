<script lang="ts">
  import Diff from './Diff.svelte';
  import AgentRuns from './AgentRuns.svelte';
  import { shortCommit } from '../format.ts';

  type Check = { id: string; status: string };
  type Receipt = { status: string; checks: Check[] };
  type Stage = { agent: string; run: { status: string; provider?: string; model?: string; result?: Record<string, any> } };
  type Workflow = {
    parent: { repository: string; commit: string; task: { title: string; request: string; allowedFiles: string[] } };
    stages?: Stage[];
    baseline?: Receipt;
    candidate?: Receipt;
    failure?: string;
  };
  type Result = { outcome: string; headCommit?: string; diff?: string; workflow: Workflow };

  let { result }: { result: unknown } = $props();
  const implementation = $derived(result as Result);
  const workflow = $derived(implementation.workflow);
  const task = $derived(workflow.parent.task);
  const repository = $derived(workflow.parent.repository);
  const isVerified = $derived(implementation.outcome === 'candidate_verified');
  const stageOf = (agent: string) => workflow.stages?.find((stage) => stage.agent === agent);
  const patch = $derived(stageOf('scoped-patch')?.run.result);
  type Finding = { severity: 'blocking' | 'advisory'; path: string; line: number; criterionIds: string[]; explanation: string };
  const review = $derived(stageOf('change-review')?.run.result as { verdict: string; findings: Finding[]; limitations: string[] } | undefined);
  const checkIds = $derived([...new Set([...(workflow.baseline?.checks ?? []), ...(workflow.candidate?.checks ?? [])].map((check) => check.id))]);
  const statusIn = (receipt: Receipt | undefined, id: string) => receipt?.checks.find((check) => check.id === id)?.status ?? '—';
  const commitLink = (commit: string) => `https://github.com/${repository}/commit/${commit}`;
</script>

<div class={`banner ${isVerified ? 'ok' : 'failed'}`}>
  <strong>{isVerified ? 'Candidate verified' : implementation.outcome.replaceAll('_', ' ')}</strong>
  <span class="muted">{repository} · base <a href={commitLink(workflow.parent.commit)} target="_blank" rel="noopener noreferrer"><code>{shortCommit(workflow.parent.commit)}</code></a>{#if implementation.headCommit}{' '}→ candidate <code>{shortCommit(implementation.headCommit)}</code>{/if}</span>
</div>

<h3>Task</h3>
<p><strong>{task.title}</strong></p>
<details><summary>Request the agents read</summary><p class="request">{task.request}</p></details>
<p class="muted">Allowed files: {#each task.allowedFiles as file}<code class="file">{file}</code>{/each}</p>

{#if patch?.summary}
  <h3>What changed</h3>
  <p>{patch.summary}</p>
{/if}

<h3>Diff</h3>
{#if implementation.diff}<Diff diff={implementation.diff} />{:else}<p class="muted">No diff was produced.</p>{/if}

{#if checkIds.length}
  <h3>Checks</h3>
  <table class="checks">
    <thead><tr><th>Check</th><th>Before the change</th><th>With the change</th></tr></thead>
    <tbody>
      {#each checkIds as id}
        <tr>
          <td><code>{id}</code></td>
          <td><span class={`check ${statusIn(workflow.baseline, id)}`}>{statusIn(workflow.baseline, id)}</span></td>
          <td><span class={`check ${statusIn(workflow.candidate, id)}`}>{statusIn(workflow.candidate, id)}</span></td>
        </tr>
      {/each}
    </tbody>
  </table>
  <p class="muted small">A check that fails before the change and passes with it shows the change did what the task asked.</p>
{/if}

{#if review}
  <h3>Review</h3>
  <p><span class="tag">{review.verdict.replaceAll('_', ' ')}</span></p>
  {#if review.findings.length}
    <ul>
      {#each review.findings as finding}
        <li class:blocking={finding.severity === 'blocking'}><strong>{finding.severity}</strong> <code>{finding.path}:{finding.line}</code> ({finding.criterionIds.join(', ')}): {finding.explanation}</li>
      {/each}
    </ul>
  {/if}
  {#if review.limitations.length}
    <details><summary>Limitations the reviewer noted</summary><ul>{#each review.limitations as limitation}<li>{limitation}</li>{/each}</ul></details>
  {/if}
{/if}

{#if workflow.failure}<p class="error">{workflow.failure}</p>{/if}

<AgentRuns stages={workflow.stages ?? []} />

<style>
  .banner { display: flex; flex-wrap: wrap; gap: 0.3rem 0.8rem; align-items: baseline; padding: 0.6rem 0.8rem; border-radius: 6px; border: 1px solid var(--line); }
  .banner.ok { border-color: var(--ok); }
  .banner.ok strong { color: var(--ok); }
  .banner.failed { border-color: var(--danger); }
  .banner.failed strong { color: var(--danger); }
  h3 { font-size: 0.95rem; margin: 1.2rem 0 0.4rem; }
  .request { white-space: pre-wrap; }
  .file { margin-left: 0.4rem; }
  .checks { border-collapse: collapse; }
  .checks th, .checks td { text-align: left; padding: 0.3rem 0.8rem 0.3rem 0; border-bottom: 1px solid var(--line); }
  .checks th { color: var(--muted); font-size: 0.85rem; font-weight: 600; }
  .check.passed { color: var(--ok); }
  .check.failed { color: var(--danger); }
  .small { font-size: 0.8rem; }
  .blocking strong { color: var(--danger); }
</style>
