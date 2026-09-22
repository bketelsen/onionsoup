<script lang="ts">
  import { untrack, type Component } from 'svelte';
  import SchemaForm from './SchemaForm.svelte';
  import ErrorText from './ui/ErrorText.svelte';
  import Time from './ui/Time.svelte';
  import Outcome from './ui/Outcome.svelte';
  import ApproveAssist from './assists/ApproveAssist.svelte';
  import { store, ApiError } from './store.svelte.ts';
  import { pruned } from './schema.ts';
  import { subjectOf } from './jobs.ts';
  import { duration } from './format.ts';

  let { id, prefill = {} }: { id: string; prefill?: Record<string, string> } = $props();
  const capability = $derived(store.capability(id));

  /** Context shown above a capability's form, keyed by capability. */
  const ASSISTS: Record<string, Component<{ input: Record<string, unknown> }>> = { 'change.approve': ApproveAssist };
  const Assist = $derived(ASSISTS[id]);

  const initialInput = () => store.takeDraft(id) ?? (Object.keys(prefill).length ? { ...prefill } : undefined);
  let input = $state<unknown>(untrack(initialInput));
  let isSubmitting = $state(false);
  let error = $state<string | null>(null);
  let showSchema = $state(false);

  const recent = $derived(store.jobList.filter((job) => job.capability === id).slice(0, 8));

  async function run(event: SubmitEvent) {
    event.preventDefault();
    if (!capability) return;
    isSubmitting = true;
    error = null;
    try {
      const jobId = await store.submit(capability.id, pruned(capability.inputSchema, $state.snapshot(input)));
      location.hash = `#/jobs/${jobId}`;
    } catch (e) {
      error = e instanceof ApiError ? (e.detail?.length ? `${e.code}: ${e.detail.join('; ')}` : e.code) : String(e);
    } finally {
      isSubmitting = false;
    }
  }
</script>

{#if !store.discovery}
  <p>Loading…</p>
{:else if !capability}
  <ErrorText error={`unknown_capability:${id}`} />
  <p><a href="#/jobs/new">Choose a capability</a></p>
{:else}
  <p class="crumbs"><a href="#/jobs">Jobs</a> / <a href="#/jobs/new">New job</a> / {capability.id}</p>
  <h1>{capability.id} <span class="muted">{capability.version}</span></h1>
  <p>{capability.description}</p>
  <p class="effects">
    {#each capability.effects as effect}<span class="tag">{effect.replaceAll('_', ' ')}</span>{/each}
    <span class="tag">deadline {duration(capability.timeoutMs)}</span>
  </p>
  {#if capability.interactive}
    <p class="decision">Submitting this form records your decision. It is the approval, and it is kept with the job.</p>
  {/if}

  <form onsubmit={run} class="panel">
    {#if Assist && input && typeof input === 'object'}<Assist input={input as Record<string, unknown>} />{/if}
    {#key capability.id}
      <SchemaForm schema={capability.inputSchema} bind:value={input} />
    {/key}
    {#if error}<ErrorText {error} />{/if}
    <div class="actions">
      <button type="submit" disabled={isSubmitting}>{isSubmitting ? 'Submitting…' : capability.interactive ? 'Approve and run' : 'Run'}</button>
      <button type="button" class="secondary" onclick={() => (showSchema = !showSchema)}>{showSchema ? 'Hide' : 'Show'} schema</button>
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
        <li><a href={`#/jobs/${job.jobId}`}><span class={`status ${job.status}`}>{job.status}</span> {subjectOf(job) || job.capability}</a> <Outcome {job} /> <span class="muted"><Time at={job.createdAt} /></span></li>
      {/each}
    </ul>
  {/if}
{/if}

<style>
  .effects { display: flex; flex-wrap: wrap; gap: 0.3rem; }
  .decision { border-left: 3px solid var(--accent); padding-left: 0.8rem; }
  form.panel { display: grid; gap: 1rem; }
  .actions { display: flex; gap: 0.5rem; flex-wrap: wrap; }
  ul.jobs { list-style: none; padding: 0; display: grid; gap: 0.3rem; }
  ul.jobs a { color: inherit; text-decoration: none; }
</style>
