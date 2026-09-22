<script lang="ts">
  import { summarizeError } from '../reasons.ts';

  type StepOutcome = { id: string; capability: string; jobId?: string; status: string; error?: string };
  let { result }: { result: unknown } = $props();
  const run = $derived(result as { recipe: string; params: unknown; steps: StepOutcome[] });
</script>

<p><span class="tag">recipe {run.recipe}</span></p>
<ol class="steps">
  {#each run.steps as step}
    <li>
      <span class={`status ${step.status}`}>{step.status}</span>
      {#if step.jobId}<a href={`#/jobs/${step.jobId}`}>{step.id}</a>{:else}{step.id}{/if}
      <span class="muted">{step.capability}</span>
      {#if step.error}<span class="error" title={step.error}>{summarizeError(step.error)}</span>{/if}
    </li>
  {/each}
</ol>
<details><summary>Parameters</summary><pre>{JSON.stringify(run.params, null, 2)}</pre></details>

<style>
  ol.steps { display: grid; gap: 0.3rem; padding-left: 1.2rem; }
</style>
