<script lang="ts">
  import type { Job } from '../store.svelte.ts';
  import { summarizeError } from '../reasons.ts';

  let { job }: { job: Job } = $props();
</script>

{#if job.outcome}
  <span class={`outcome ${job.outcome.status}`}>{job.outcome.label}</span>
{:else if job.error}
  <span class="outcome failed" title={job.error}>{summarizeError(job.error)}</span>
{/if}
