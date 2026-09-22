<script lang="ts">
  import { store } from '../store.svelte.ts';
  import { citedFiles, proposalOf, workflowOf } from '../results/proposal.ts';

  /** Shows the chosen proposal and lets the person narrow the files it cites. */
  let { input }: { input: Record<string, unknown> } = $props();
  const proposalJob = $derived(typeof input.proposalJobId === 'string' ? store.jobs[input.proposalJobId] : undefined);
  $effect(() => {
    if (proposalJob && proposalJob.status === 'completed' && proposalJob.result === undefined) store.refresh(proposalJob.jobId).catch(() => {});
  });
  const workflow = $derived(proposalJob?.result ? workflowOf(proposalJob.result) : undefined);
  const proposal = $derived(workflow ? proposalOf(workflow) : undefined);
  const cited = $derived(proposalJob?.result ? citedFiles(proposalJob.result) : []);
  const chosen = $derived(Array.isArray(input.allowedFiles) && input.allowedFiles.length ? (input.allowedFiles as string[]) : cited);

  function toggle(path: string, isChecked: boolean) {
    const next = isChecked ? [...new Set([...chosen, path])] : chosen.filter((file) => file !== path);
    input.allowedFiles = next.length === cited.length && cited.every((file) => next.includes(file)) ? [] : next;
  }
</script>

{#if workflow}
  <div class="assist panel">
    <p><strong>#{workflow.parent.issue.number} {workflow.parent.issue.title}</strong></p>
    {#if proposal}
      <p>{proposal.outcome.text}</p>
      {#if proposal.status === 'needs_information'}<p class="warn">The proposal asked for more information. Add an override note below to proceed anyway.</p>{/if}
    {/if}
    {#if cited.length}
      <fieldset>
        <legend>Files the agents may edit</legend>
        {#each cited as path (path)}
          <label class="check"><input type="checkbox" checked={chosen.includes(path)} onchange={(event) => toggle(path, event.currentTarget.checked)} /> <code>{path}</code></label>
        {/each}
      </fieldset>
      <small class="muted">Leave all checked to allow every cited file. Files outside the repository profile are refused.</small>
    {/if}
  </div>
{/if}

<style>
  .assist { display: grid; gap: 0.3rem; }
  .assist p { margin: 0.1rem 0; }
  fieldset { border: 1px solid var(--line); border-radius: 6px; padding: 0.5rem 0.8rem; display: grid; gap: 0.2rem; }
  legend { font-weight: 600; font-size: 0.9rem; }
  .check { display: flex; gap: 0.4rem; align-items: center; }
  .warn { color: var(--warn); }
</style>
