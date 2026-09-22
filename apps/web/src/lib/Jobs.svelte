<script lang="ts">
  import { store, isActive, type Job } from './store.svelte.ts';
  import { hasFailed, subjectOf } from './jobs.ts';
  import { duration } from './format.ts';
  import Time from './ui/Time.svelte';
  import Outcome from './ui/Outcome.svelte';
  import ConfirmButton from './ui/ConfirmButton.svelte';

  /** Status filters, keyed by chip. */
  const FILTERS: Record<string, { label: string; test: (job: Job) => boolean }> = {
    all: { label: 'All', test: () => true },
    active: { label: 'Running', test: isActive },
    failed: { label: 'Needs a look', test: hasFailed },
    completed: { label: 'Completed', test: (job) => job.status === 'completed' && !hasFailed(job) },
  };

  let filter = $state('all');
  let search = $state('');
  let expanded = $state<Record<string, boolean>>({});

  const matchesSearch = (job: Job) => !search || `${job.capability} ${subjectOf(job)}`.toLowerCase().includes(search.toLowerCase());
  const stepsOf = (parentId: string) => store.jobList.filter((job) => job.parentJobId === parentId).reverse();
  const top = $derived(store.jobList.filter((job) => !job.parentJobId && FILTERS[filter].test(job) && matchesSearch(job)));
  const countOf = (key: string) => store.jobList.filter((job) => !job.parentJobId && FILTERS[key].test(job)).length;
  const elapsed = (job: Job) => (job.status === 'queued' ? '' : duration(Date.parse(job.events.at(-1)!.at) - Date.parse(job.events[0].at)));
</script>

<div class="head">
  <h1>Jobs</h1>
  <a class="button" href="#/jobs/new">New job</a>
</div>
<div class="filters">
  <div class="chips" role="group" aria-label="Filter by status">
    {#each Object.entries(FILTERS) as [key, option] (key)}
      <button type="button" class="chip" class:current={filter === key} aria-pressed={filter === key} onclick={() => { filter = key; }}>{option.label} <span class="count">{countOf(key)}</span></button>
    {/each}
  </div>
  <label class="visually-hidden" for="job-search">Search jobs</label>
  <input id="job-search" type="search" placeholder="Search capability or subject" bind:value={search} />
</div>

{#snippet row(job: Job, isStep: boolean)}
  <tr class:step={isStep}>
    <td><span class={`status ${job.status}`}>{job.status}</span></td>
    <td>
      {#if !isStep && stepsOf(job.jobId).length}
        <button type="button" class="toggle" aria-expanded={Boolean(expanded[job.jobId])} aria-label={`${expanded[job.jobId] ? 'Hide' : 'Show'} steps`} onclick={() => { expanded[job.jobId] = !expanded[job.jobId]; }}>{expanded[job.jobId] ? '▾' : '▸'}</button>
      {/if}
      <a href={`#/jobs/${job.jobId}`}>{job.capability}</a>
      {#if subjectOf(job)}<div class="subject">{subjectOf(job)}</div>{/if}
    </td>
    <td><Outcome {job} /></td>
    <td class="inline" data-label="Started"><Time at={job.createdAt} /></td>
    <td class="inline" data-label="Took">{elapsed(job)}</td>
    <td>{#if isActive(job)}<ConfirmButton small label="Cancel" confirmLabel="cancel" onconfirm={() => store.cancel(job.jobId)} />{/if}</td>
  </tr>
{/snippet}

{#if store.jobList.length === 0}
  <p>No jobs yet. <a href="#/">Ask in chat</a> or <a href="#/jobs/new">start one</a>.</p>
{:else if top.length === 0}
  <p class="muted">No jobs match.</p>
{:else}
  <table class="list">
    <thead><tr><th>Status</th><th>Job</th><th>Outcome</th><th>Started</th><th>Took</th><th><span class="visually-hidden">Actions</span></th></tr></thead>
    <tbody>
      {#each top as job (job.jobId)}
        {@render row(job, false)}
        {#if expanded[job.jobId]}
          {#each stepsOf(job.jobId) as child (child.jobId)}{@render row(child, true)}{/each}
        {/if}
      {/each}
    </tbody>
  </table>
{/if}

<style>
  .head { display: flex; align-items: center; justify-content: space-between; gap: 1rem; }
  .filters { display: flex; gap: 0.8rem; align-items: center; flex-wrap: wrap; margin-bottom: 0.8rem; }
  .chips { display: flex; gap: 0.3rem; flex-wrap: wrap; }
  .chip { background: transparent; color: var(--text); border: 1px solid var(--line); border-radius: 999px; padding: 0.15rem 0.7rem; font-size: 0.85rem; }
  .chip.current { border-color: var(--accent); color: var(--accent); }
  .count { color: var(--muted); }
  .subject { color: var(--muted); font-size: 0.85rem; overflow-wrap: anywhere; }
  .toggle { background: none; color: var(--muted); padding: 0 0.3rem 0 0; border: 0; }
  tr.step td:nth-child(2) { padding-left: 2rem; }
  td:nth-child(3) { max-width: 22rem; }
  td:nth-child(4), td:nth-child(5) { white-space: nowrap; }
</style>
