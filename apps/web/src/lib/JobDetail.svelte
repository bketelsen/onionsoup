<script lang="ts">
  import { store } from './store.svelte.ts';

  let { id }: { id: string } = $props();
  const job = $derived(store.jobs[id]);
  let loading = $state(false);

  // Completed jobs carry their result only on a direct read; fetch it once the status settles.
  $effect(() => {
    if (job && job.status === 'completed' && job.result === undefined && !loading) {
      loading = true;
      store.refresh(id).finally(() => { loading = false; });
    }
  });
  $effect(() => {
    if (!job) store.refresh(id).catch(() => {});
  });

  function download() {
    const blob = new Blob([JSON.stringify(job.result, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${job.capability}-${job.jobId}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  function markdownOf(result: unknown): string | undefined {
    if (!result || typeof result !== 'object') return undefined;
    const r = result as Record<string, unknown>;
    for (const key of ['markdown', 'text', 'summary']) if (typeof r[key] === 'string') return r[key] as string;
    const brief = r.brief as Record<string, unknown> | undefined;
    if (brief && typeof brief.markdown === 'string') return brief.markdown;
    return undefined;
  }
  const markdown = $derived(job?.result !== undefined ? markdownOf(job.result) : undefined);
</script>

{#if !job}
  <p>Loading job…</p>
{:else}
  <p class="crumbs"><a href="#/jobs">Jobs</a> / {job.jobId}</p>
  <h1><span class={`status ${job.status}`}>{job.status}</span> <a href={`#/run/${job.capability}`}>{job.capability}</a> <span class="muted">{job.version}</span></h1>

  {#if job.status === 'queued' || job.status === 'running'}
    <p><button class="secondary" onclick={() => store.cancel(job.jobId)}>Cancel</button></p>
  {/if}
  {#if job.error}
    <p class="error">{job.error}</p>
  {/if}

  <h2>Timeline</h2>
  <ol class="timeline">
    {#each job.events as event (event.sequence)}
      <li><span class={`status ${event.status}`}>{event.status}</span> {new Date(event.at).toLocaleString()}</li>
    {/each}
  </ol>

  <h2>Input</h2>
  <pre>{JSON.stringify(job.input, null, 2)}</pre>

  {#if job.status === 'completed'}
    <h2>Result {#if job.result !== undefined}<button class="secondary small" onclick={download}>Download JSON</button>{/if}</h2>
    {#if job.result === undefined}
      <p>Loading result…</p>
    {:else}
      {#if markdown}
        <pre class="markdown">{markdown}</pre>
        <details><summary>Raw JSON</summary><pre>{JSON.stringify(job.result, null, 2)}</pre></details>
      {:else}
        <pre>{JSON.stringify(job.result, null, 2)}</pre>
      {/if}
    {/if}
  {/if}

  {#if job.parentJobId || job.correlationId}
    <h2>Provenance</h2>
    <ul>
      {#if job.parentJobId}<li>Parent <a href={`#/jobs/${job.parentJobId}`}>{job.parentJobId}</a></li>{/if}
      {#if job.correlationId}<li>Correlation <code>{job.correlationId}</code></li>{/if}
      <li>Idempotency key <code>{job.idempotencyKey}</code></li>
    </ul>
  {/if}
{/if}

<style>
  .crumbs { color: var(--muted); }
  .timeline { padding-left: 1.2rem; }
  pre.markdown { white-space: pre-wrap; font-family: inherit; line-height: 1.5; }
</style>
