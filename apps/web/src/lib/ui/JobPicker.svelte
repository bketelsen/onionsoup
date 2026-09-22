<script lang="ts">
  import { store, type Job } from '../store.svelte.ts';
  import { subjectOf } from '../jobs.ts';
  import { ago } from '../format.ts';

  /** Picks a completed job of one of `capabilities`, or takes a pasted ID. */
  let { id, capabilities, value = $bindable(), required = false }: { id: string; capabilities: string[]; value: unknown; required?: boolean } = $props();

  const candidates = $derived(store.jobList.filter((job) => capabilities.includes(job.capability) && job.status === 'completed'));
  const isKnown = $derived(typeof value === 'string' && candidates.some((job) => job.jobId === value));
  let isPasting = $state(false);

  const label = (job: Job) => [subjectOf(job) || job.capability, job.outcome?.label, ago(job.createdAt, store.now)].filter(Boolean).join(' · ');
</script>

{#if isPasting || (typeof value === 'string' && value && !isKnown)}
  <div class="row">
    <input {id} type="text" bind:value placeholder="job ID" {required} />
    <button type="button" class="secondary small" onclick={() => { isPasting = false; value = ''; }}>Choose from list</button>
  </div>
{:else}
  <div class="row">
    <select {id} bind:value {required}>
      <option value="">{candidates.length ? 'Choose a job…' : `No completed ${capabilities.join(' or ')} jobs yet`}</option>
      {#each candidates as job (job.jobId)}
        <option value={job.jobId}>{label(job)}</option>
      {/each}
    </select>
    <button type="button" class="secondary small" onclick={() => { isPasting = true; }}>Paste an ID</button>
  </div>
{/if}
{#if isKnown}<small><a href={`#/jobs/${value}`}>Open {store.jobs[value as string].capability} job</a></small>{/if}

<style>
  .row { display: flex; gap: 0.4rem; align-items: center; flex-wrap: wrap; }
</style>
