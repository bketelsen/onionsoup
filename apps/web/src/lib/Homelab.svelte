<script lang="ts">
  import { store, isActive, ApiError } from './store.svelte.ts';
  import Markdown from './Markdown.svelte';
  import Time from './ui/Time.svelte';
  import ErrorText from './ui/ErrorText.svelte';

  let error = $state<string | null>(null);
  /** Jobs this page started and is waiting on, keyed by source ID or "brief". */
  let pending = $state<Record<string, string>>({});

  $effect(() => { store.loadSources().catch((e) => { error = String(e); }); });
  $effect(() => {
    for (const [key, jobId] of Object.entries(pending)) {
      const job = store.jobs[jobId];
      if (!job || isActive(job)) continue;
      delete pending[key];
      if (job.error) error = job.error;
      store.loadSources().catch(() => {});
    }
  });

  const can = (capability: string) => Boolean(store.capability(capability));
  const latestBrief = $derived(store.jobList.find((job) => job.capability === 'homelab.brief' && job.status === 'completed'));
  $effect(() => {
    if (latestBrief && latestBrief.result === undefined) store.refresh(latestBrief.jobId).catch(() => {});
  });
  const briefMarkdown = $derived((latestBrief?.result as { markdown?: string } | undefined)?.markdown);

  async function start(key: string, capability: string, input: Record<string, unknown>) {
    error = null;
    try {
      pending[key] = await store.submit(capability, input);
    } catch (e) {
      error = e instanceof ApiError ? e.code : String(e);
    }
  }
  const pendingStatus = (key: string) => store.jobs[pending[key]]?.status ?? 'queued';
</script>

<div class="head">
  <h1>Homelab</h1>
  {#if can('homelab.brief')}
    <div class="actions">
      {#if pending.brief}
        <a href={`#/jobs/${pending.brief}`}><span class={`status ${pendingStatus('brief')}`}>{pendingStatus('brief')}</span> brief</a>
      {:else}
        <button type="button" onclick={() => start('brief', 'homelab.brief', { refresh: false })}>New brief</button>
        <button type="button" class="secondary" onclick={() => start('brief', 'homelab.brief', { refresh: true })}>Collect everything, then brief</button>
      {/if}
    </div>
  {/if}
</div>
{#if error}<ErrorText {error} />{/if}

<h2>Sources</h2>
{#if store.sources.length === 0}
  <p>No sources yet. <a href="#/settings/sources">Add one in Settings</a>.</p>
{:else}
  <table class="list">
    <thead><tr><th>Source</th><th>Last observed</th><th>Last assessment</th><th><span class="visually-hidden">Actions</span></th></tr></thead>
    <tbody>
      {#each store.sources as source (source.sourceId)}
        <tr class:attention={source.latestInvestigation?.attention}>
          <td data-label="Source"><strong>{source.sourceId}</strong> <span class="tag">{source.kind}</span><div class="muted small">{source.detail}</div></td>
          <td data-label="Last observed">{#if source.latestObservation}<Time at={source.latestObservation.at} /> <span class="muted">· {source.latestObservation.status}</span>{:else}<span class="muted">never</span>{/if}</td>
          <td data-label="Last assessment">
            {#if source.latestInvestigation}
              {#if source.latestInvestigation.attention}<span class="outcome attention">needs attention</span>{/if}
              {source.latestInvestigation.summary} <span class="muted">· <Time at={source.latestInvestigation.at} /></span>
            {:else}<span class="muted">not yet</span>{/if}
          </td>
          <td class="row-actions">
            {#if pending[source.sourceId]}
              <a href={`#/jobs/${pending[source.sourceId]}`}><span class={`status ${pendingStatus(source.sourceId)}`}>{pendingStatus(source.sourceId)}</span></a>
            {:else}
              {#if can('homelab.refresh')}<button type="button" class="secondary small" onclick={() => start(source.sourceId, 'homelab.refresh', { sourceId: source.sourceId })}>Refresh</button>{/if}
              {#if can('homelab.investigate')}<button type="button" class="secondary small" onclick={() => start(source.sourceId, 'homelab.investigate', { sourceId: source.sourceId })}>Investigate</button>{/if}
            {/if}
          </td>
        </tr>
      {/each}
    </tbody>
  </table>
  <p class="muted small">Refresh collects read-only evidence. Investigate also assesses what needs attention. <a href="#/settings/sources">Manage sources</a></p>
{/if}

{#if latestBrief}
  <h2>Latest brief <span class="muted small">· <Time at={latestBrief.createdAt} /> · <a href={`#/jobs/${latestBrief.jobId}`}>job</a></span></h2>
  <section class="panel">
    {#if briefMarkdown}<Markdown source={briefMarkdown} />{:else}<p>Loading brief…</p>{/if}
  </section>
{/if}

<style>
  .head { display: flex; align-items: center; justify-content: space-between; gap: 1rem; flex-wrap: wrap; }
  .actions, .row-actions { display: flex; gap: 0.4rem; align-items: center; flex-wrap: wrap; }
  tr.attention td:first-child { box-shadow: inset 3px 0 0 var(--warn); }
  .small { font-size: 0.82rem; }
  section.panel { overflow-x: auto; }
</style>
