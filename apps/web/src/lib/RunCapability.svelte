<script lang="ts">
  import { untrack } from 'svelte';
  import SchemaForm from './SchemaForm.svelte';
  import { store, ApiError } from './store.svelte.ts';

  let { id, prefill = {} }: { id: string; prefill?: Record<string, string> } = $props();
  const capability = $derived(store.capability(id));

  let input = $state<unknown>(untrack(() => (Object.keys(prefill).length ? { ...prefill } : undefined)));
  let submitting = $state(false);
  let error = $state<string | null>(null);
  let showSchema = $state(false);

  const recent = $derived(store.jobList.filter((j) => j.capability === id).slice(0, 8));

  async function run(event: SubmitEvent) {
    event.preventDefault();
    if (!capability) return;
    submitting = true;
    error = null;
    try {
      const jobId = await store.submit(capability.id, input);
      location.hash = `#/jobs/${jobId}`;
    } catch (e) {
      error = e instanceof ApiError ? e.message : String(e);
    } finally {
      submitting = false;
    }
  }
</script>

{#if !store.discovery}
  <p>Loading…</p>
{:else if !capability}
  <p class="error">Unknown capability <code>{id}</code>.</p>
{:else}
  <p class="crumbs"><a href="#/">Capabilities</a> / {capability.id}</p>
  <h1>{capability.id} <span class="muted">{capability.version}</span></h1>
  <p>{capability.description}</p>
  <p class="effects">
    {#each capability.effects as effect}<span class="tag">{effect.replaceAll('_', ' ')}</span>{/each}
    <span class="tag">deadline {Math.round(capability.timeoutMs / 1000)}s</span>
  </p>

  <form onsubmit={run} class="panel">
    {#key capability.id}
      <SchemaForm schema={capability.inputSchema} bind:value={input} />
    {/key}
    {#if error}<p class="error">{error}</p>{/if}
    <div class="actions">
      <button type="submit" disabled={submitting}>{submitting ? 'Submitting…' : 'Run'}</button>
      <button type="button" class="secondary" onclick={() => (showSchema = !showSchema)}>{showSchema ? 'Hide' : 'Show'} details</button>
    </div>
  </form>

  {#if showSchema}
    <details open>
      <summary>Input schema</summary>
      <pre>{JSON.stringify(capability.inputSchema, null, 2)}</pre>
    </details>
    <details>
      <summary>Metadata</summary>
      <pre>{JSON.stringify(capability.metadata, null, 2)}</pre>
    </details>
  {/if}

  {#if recent.length}
    <h2>Recent runs</h2>
    <ul class="jobs">
      {#each recent as job (job.jobId)}
        <li><a href={`#/jobs/${job.jobId}`}><span class={`status ${job.status}`}>{job.status}</span> {new Date(job.createdAt).toLocaleString()}</a></li>
      {/each}
    </ul>
  {/if}
{/if}

<style>
  .crumbs { color: var(--muted); }
  .effects { display: flex; flex-wrap: wrap; gap: 0.3rem; }
  form.panel { display: grid; gap: 1rem; }
  .actions { display: flex; gap: 0.5rem; }
  ul.jobs { list-style: none; padding: 0; display: grid; gap: 0.3rem; }
  ul.jobs a { color: inherit; text-decoration: none; }
</style>
