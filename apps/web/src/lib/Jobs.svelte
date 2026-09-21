<script lang="ts">
  import { store } from './store.svelte.ts';

  let filter = $state('');
  const jobs = $derived(store.jobList.filter((j) => !filter || j.capability.includes(filter) || j.status === filter));
</script>

<h1>Jobs</h1>
<p class="muted">
  {store.connected ? 'Live' : 'Reconnecting…'} · {store.jobList.length} total
  <input type="search" placeholder="filter by capability or status" bind:value={filter} />
</p>
{#if jobs.length === 0}
  <p>No jobs yet. <a href="#/">Run a capability.</a></p>
{:else}
  <table>
    <thead><tr><th>Status</th><th>Capability</th><th>Created</th><th>Duration</th><th></th></tr></thead>
    <tbody>
      {#each jobs as job (job.jobId)}
        {@const first = job.events[0]}
        {@const last = job.events[job.events.length - 1]}
        <tr>
          <td><span class={`status ${job.status}`}>{job.status}</span></td>
          <td><a href={`#/jobs/${job.jobId}`}>{job.capability}</a></td>
          <td>{new Date(job.createdAt).toLocaleString()}</td>
          <td>{job.status === 'queued' ? '' : Math.round((Date.parse(last.at) - Date.parse(first.at)) / 1000) + 's'}</td>
          <td>
            {#if job.status === 'queued' || job.status === 'running'}
              <button class="secondary small" onclick={() => store.cancel(job.jobId)}>Cancel</button>
            {/if}
          </td>
        </tr>
      {/each}
    </tbody>
  </table>
{/if}

<style>
  input[type='search'] { margin-left: 1rem; }
  table { width: 100%; border-collapse: collapse; }
  th, td { text-align: left; padding: 0.5rem 0.6rem; border-bottom: 1px solid var(--line); }
  th { color: var(--muted); font-weight: 600; font-size: 0.85rem; }
</style>
