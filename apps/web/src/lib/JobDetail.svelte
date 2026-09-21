<script lang="ts">
  import { store, type Job } from './store.svelte.ts';
  import Result from './results/Result.svelte';

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

  // Jobs reference each other by ID inside their input (readinessJobId, packetJobId, …) or as parentJobId.
  function references(j: Job): string[] {
    const found: string[] = [];
    const walk = (v: unknown) => {
      if (typeof v === 'string' && /^[0-9a-f-]{36}$/.test(v) && store.jobs[v]) found.push(v);
      else if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v === 'object') Object.values(v).forEach(walk);
    };
    walk(j.input);
    if (j.parentJobId) found.push(j.parentJobId);
    return [...new Set(found)];
  }
  const parents = $derived(job ? references(job) : []);
  const children = $derived(store.jobList.filter((j) => j.jobId !== id && references(j).includes(id)));

  type NextStep = { label: string; href: string };
  type NextRule = (job: Job) => NextStep[];
  const readyBug = (job: Job) => {
    const r = job.result as { run?: { assessment?: { kind?: string; bug_readiness?: string } } } | undefined;
    return r?.run?.assessment?.kind === 'bug_report' && r.run.assessment.bug_readiness === 'ready';
  };
  const verified = (job: Job) => (job.result as { outcome?: string } | undefined)?.outcome === 'candidate_verified';
  const has = (id: string) => Boolean(store.capability(id));
  /** What a person can do with a completed job, keyed by the capability that produced it. */
  const nextSteps: Record<string, NextRule> = {
    'issue.readiness': (job) => (readyBug(job) && has('code.location') ? [{ label: 'Locate code', href: `#/run/code.location?readinessJobId=${job.jobId}` }] : []),
    'investigation.packet': (job) => (has('change.proposal') ? [{ label: 'Draft proposal', href: `#/run/change.proposal?packetJobId=${job.jobId}` }] : []),
    'change.proposal': (job) => (has('change.approve') ? [{ label: 'Approve for implementation', href: `#/run/change.approve?proposalJobId=${job.jobId}` }] : []),
    'change.approve': (job) => (has('change.implement') ? [{ label: 'Implement', href: `#/run/change.implement?approvalJobId=${job.jobId}` }] : []),
    'change.implement': (job) => (verified(job) && has('change.publish') ? [{ label: 'Publish draft PR', href: `#/run/change.publish?implementJobId=${job.jobId}` }] : []),
  };
  const next = $derived(job?.status === 'completed' ? (nextSteps[job.capability] ?? (() => []))(job) : []);
</script>

{#if !job}
  <p>Loading job…</p>
{:else}
  <p class="crumbs"><a href="#/jobs">Jobs</a> / {job.jobId}</p>
  <h1><span class={`status ${job.status}`}>{job.status}</span> <a href={`#/run/${job.capability}`}>{job.capability}</a> <span class="muted">{job.version}</span></h1>

  <p class="actions">
    {#if job.status === 'queued' || job.status === 'running'}
      <button class="secondary" onclick={() => store.cancel(job.jobId)}>Cancel</button>
    {/if}
    {#each next as n}<a class="button" href={n.href}>{n.label}</a>{/each}
    {#if job.result !== undefined}<button class="secondary small" onclick={download}>Download JSON</button>{/if}
  </p>
  {#if job.error}
    <p class="error">{job.error}</p>
  {/if}

  {#if job.status === 'completed'}
    <section class="panel">
      {#if job.result === undefined}
        <p>Loading result…</p>
      {:else}
        <Result capability={job.capability} result={job.result} />
      {/if}
    </section>
  {/if}

  <h2>Timeline</h2>
  <ol class="timeline">
    {#each job.events as event (event.sequence)}
      <li><span class={`status ${event.status}`}>{event.status}</span> {new Date(event.at).toLocaleString()}</li>
    {/each}
  </ol>

  {#if parents.length || children.length}
    <h2>Related jobs</h2>
    <ul>
      {#each parents as p}<li>Uses <a href={`#/jobs/${p}`}>{store.jobs[p].capability}</a> <span class={`status ${store.jobs[p].status}`}>{store.jobs[p].status}</span></li>{/each}
      {#each children as c}<li>Used by <a href={`#/jobs/${c.jobId}`}>{c.capability}</a> <span class={`status ${c.status}`}>{c.status}</span></li>{/each}
    </ul>
  {/if}

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
      <li>Idempotency key <code>{job.idempotencyKey}</code></li>
      {#if job.correlationId}<li>Correlation <code>{job.correlationId}</code></li>{/if}
      {#if job.parentJobId}<li>Parent <a href={`#/jobs/${job.parentJobId}`}>{job.parentJobId}</a></li>{/if}
    </ul>
  </details>
{/if}

<style>
  .crumbs { color: var(--muted); }
  .actions { display: flex; gap: 0.5rem; align-items: center; flex-wrap: wrap; }
  a.button { background: var(--accent); color: #fff; border-radius: 6px; padding: 0.45rem 0.9rem; text-decoration: none; }
  .timeline { padding-left: 1.2rem; }
  section.panel { margin-top: 1rem; }
</style>
