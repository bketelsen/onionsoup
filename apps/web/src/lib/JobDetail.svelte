<script lang="ts">
  import { store, isActive, ApiError } from './store.svelte.ts';
  import Result from './results/Result.svelte';
  import Time from './ui/Time.svelte';
  import Outcome from './ui/Outcome.svelte';
  import ErrorText from './ui/ErrorText.svelte';
  import ConfirmButton from './ui/ConfirmButton.svelte';
  import { childrenOf, nextStepsFor, referencesOf, subjectOf } from './jobs.ts';
  import { duration, stamp } from './format.ts';

  let { id }: { id: string } = $props();
  const job = $derived(store.jobs[id]);
  let isLoading = $state(false);
  let loadError = $state<string | null>(null);

  // Completed jobs carry their result only on a direct read; fetch it once the status settles.
  $effect(() => {
    if (job && job.status === 'completed' && job.result === undefined && !isLoading) {
      isLoading = true;
      store.refresh(id).finally(() => { isLoading = false; });
    }
  });
  $effect(() => {
    if (!job) store.refresh(id).catch((e) => { loadError = e instanceof ApiError ? e.code : String(e); });
  });

  function download() {
    const blob = new Blob([JSON.stringify(job.result, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `${job.capability}-${job.jobId}.json`;
    link.click();
    URL.revokeObjectURL(url);
  }

  function runAgain() {
    store.draft = { capability: job.capability, input: structuredClone($state.snapshot(job.input)) };
    location.hash = `#/run/${job.capability}`;
  }

  const parents = $derived(job ? referencesOf(job).map((ref) => store.jobs[ref]) : []);
  const children = $derived(job ? childrenOf(id) : []);
  const next = $derived(job ? nextStepsFor(job) : []);
  const subject = $derived(job ? subjectOf(job) : '');
  const took = $derived(job && job.events.length > 1 ? duration(Date.parse(job.events.at(-1)!.at) - Date.parse(job.events[0].at)) : '');
  const canRunAgain = $derived(Boolean(job && store.capability(job.capability)));
</script>

{#if !job}
  {#if loadError}
    <ErrorText error={loadError} />
    <p><a href="#/jobs">Back to jobs</a></p>
  {:else}
    <p>Loading job…</p>
  {/if}
{:else}
  <p class="crumbs"><a href="#/jobs">Jobs</a> / <code>{job.jobId.slice(0, 8)}</code></p>
  <h1>{job.capability}{#if subject}<span class="subject">{subject}</span>{/if}</h1>
  <p class="summary">
    <span class={`status ${job.status}`}>{job.status}</span>
    <Outcome {job} />
    <span class="muted">started <Time at={job.createdAt} />{#if took}{' '}· took {took}{/if}</span>
  </p>

  <div class="actions">
    {#each next as step}<a class="button" href={step.href}>{step.label}</a>{/each}
    {#if isActive(job)}<ConfirmButton label="Cancel" confirmLabel="cancel this job" onconfirm={() => store.cancel(job.jobId)} />{/if}
    {#if canRunAgain && !isActive(job)}<button type="button" class="secondary" onclick={runAgain}>Run again</button>{/if}
    {#if job.result !== undefined}<button type="button" class="secondary small" onclick={download}>Download JSON</button>{/if}
  </div>

  {#if job.error}<section class="panel failure"><ErrorText error={job.error} /></section>{/if}

  {#if job.status === 'completed'}
    <section class="panel">
      {#if job.result === undefined}
        <p>Loading result…</p>
      {:else}
        <Result capability={job.capability} result={job.result} />
      {/if}
    </section>
  {:else if isActive(job)}
    <p class="muted">This page updates when the job finishes.</p>
  {/if}

  {#if parents.length || children.length}
    <h2>Related jobs</h2>
    <ul class="related">
      {#each parents as parent (parent.jobId)}<li>Builds on <a href={`#/jobs/${parent.jobId}`}>{parent.capability}</a> <span class={`status ${parent.status}`}>{parent.status}</span></li>{/each}
      {#each children as child (child.jobId)}<li>Used by <a href={`#/jobs/${child.jobId}`}>{child.capability}</a> <span class={`status ${child.status}`}>{child.status}</span></li>{/each}
    </ul>
  {/if}

  <details>
    <summary>Timeline</summary>
    <ol class="timeline">
      {#each job.events as event (event.sequence)}<li><span class={`status ${event.status}`}>{event.status}</span> {stamp(event.at)}</li>{/each}
    </ol>
  </details>
  <details>
    <summary>Input</summary>
    <pre>{JSON.stringify(job.input, null, 2)}</pre>
  </details>
  {#if job.result !== undefined}
    <details>
      <summary>Raw result JSON</summary>
      <pre>{JSON.stringify(job.result, null, 2)}</pre>
    </details>
  {/if}
  <details>
    <summary>Provenance</summary>
    <ul>
      <li>Job <code>{job.jobId}</code> · {job.version} · owner <code>{job.owner}</code></li>
      <li>Idempotency key <code>{job.idempotencyKey}</code></li>
      {#if job.correlationId}<li>Correlation <code>{job.correlationId}</code></li>{/if}
    </ul>
  </details>
{/if}

<style>
  h1 { margin-bottom: 0.3rem; overflow-wrap: anywhere; }
  .subject { color: var(--muted); font-weight: 400; margin-left: 0.5rem; }
  .summary { display: flex; gap: 0.5rem; align-items: center; flex-wrap: wrap; margin: 0 0 0.8rem; }
  .actions { display: flex; gap: 0.5rem; align-items: center; flex-wrap: wrap; margin-bottom: 1rem; }
  .timeline { padding-left: 1.2rem; }
  .related { padding-left: 1.2rem; }
  section.panel { margin-bottom: 1rem; overflow-x: auto; }
  .failure { border-color: var(--danger); }
</style>
