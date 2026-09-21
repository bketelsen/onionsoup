<script lang="ts">
  let { result }: { result: unknown } = $props();
  const r = $derived(result as { recipe: string; params: unknown; steps: { id: string; capability: string; jobId?: string; status: string; error?: string }[] });
</script>

<p><span class="tag">recipe {r.recipe}</span></p>
<ol class="steps">
  {#each r.steps as s}
    <li>
      <span class={`status ${s.status}`}>{s.status}</span>
      {#if s.jobId}<a href={`#/jobs/${s.jobId}`}>{s.id}</a>{:else}{s.id}{/if}
      <span class="muted">{s.capability}</span>
      {#if s.error}<span class="error">{s.error}</span>{/if}
    </li>
  {/each}
</ol>
<details><summary>Parameters</summary><pre>{JSON.stringify(r.params, null, 2)}</pre></details>

<style>
  ol.steps { display: grid; gap: 0.3rem; padding-left: 1.2rem; }
</style>
