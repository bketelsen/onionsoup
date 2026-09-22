<script lang="ts">
  import { store, ApiError, type HomelabSource } from './store.svelte.ts';

  let error = $state<string | null>(null);
  let pending = $state<Record<string, string>>({});
  let form = $state({ sourceId: '', kind: 'containers', host: '', user: '', access: 'direct', binary: '' });
  let submitting = $state(false);

  $effect(() => { store.loadSources().catch((e) => { error = String(e); }); });
  $effect(() => {
    for (const [sourceId, jobId] of Object.entries(pending)) {
      const job = store.jobs[jobId];
      if (job && job.status !== 'queued' && job.status !== 'running') { delete pending[sourceId]; store.loadSources().catch(() => {}); }
    }
  });
  const can = (id: string) => Boolean(store.capability(id));

  async function start(capability: string, sourceId: string) {
    error = null;
    try { pending[sourceId] = await store.submit(capability, { sourceId }); }
    catch (e) { error = e instanceof ApiError ? e.message : String(e); }
  }
  async function add(event: SubmitEvent) {
    event.preventDefault();
    submitting = true;
    error = null;
    const input: Record<string, unknown> = { sourceId: form.sourceId.trim(), kind: form.kind, host: form.host.trim() };
    if (form.kind !== 'truenas') input.user = form.user.trim();
    if (form.kind === 'kubernetes') input.access = form.access;
    if (form.kind === 'truenas') input.binary = form.binary.trim();
    try {
      const jobId = await store.submit('homelab.add-source', input);
      pending[form.sourceId.trim()] = jobId;
      form = { sourceId: '', kind: 'containers', host: '', user: '', access: 'direct', binary: '' };
    } catch (e) {
      error = e instanceof ApiError ? e.message : String(e);
    } finally {
      submitting = false;
    }
  }
  const when = (at: string | undefined) => (at ? new Date(at).toLocaleString() : 'never');
  const summary = (source: HomelabSource) => source.latestInvestigation ? `${source.latestInvestigation.summary} · ${when(source.latestInvestigation.at)}` : 'not yet';
</script>

<h1>Homelab sources</h1>
<p class="muted">TrueNAS hosts, SSH hosts running Docker, Podman or Incus, and k3s hosts. Refresh collects read-only evidence; investigate also assesses what needs attention.</p>

{#if can('homelab.add-source')}
  <form onsubmit={add} class="panel add">
    <div class="row">
      <select bind:value={form.kind}>
        <option value="containers">containers (docker, podman, incus)</option>
        <option value="kubernetes">k3s</option>
        <option value="truenas">TrueNAS</option>
      </select>
      <input bind:value={form.sourceId} placeholder="source id (lowercase)" required pattern="[a-z][a-z0-9-]*" />
      <input bind:value={form.host} placeholder="host or IP" required />
      {#if form.kind !== 'truenas'}<input bind:value={form.user} placeholder="ssh user" required />{/if}
      {#if form.kind === 'kubernetes'}<select bind:value={form.access}><option value="direct">direct</option><option value="sudo">sudo</option></select>{/if}
      {#if form.kind === 'truenas'}<input bind:value={form.binary} placeholder="/absolute/path/to/truenas-mcp" required />{/if}
      <button type="submit" disabled={submitting}>Add</button>
    </div>
  </form>
{/if}
{#if error}<p class="error">{error}</p>{/if}

{#if store.sources.length === 0}
  <p>No sources yet.</p>
{:else}
  <table>
    <thead><tr><th>Source</th><th>Kind</th><th>Where</th><th>Last observed</th><th>Last assessment</th><th></th></tr></thead>
    <tbody>
      {#each store.sources as source (source.sourceId)}
        <tr>
          <td>{source.sourceId} {#if source.origin === 'config'}<span class="tag">config</span>{/if}</td>
          <td>{source.kind}</td>
          <td>{source.detail}</td>
          <td>{source.latestObservation ? `${source.latestObservation.status} · ${when(source.latestObservation.at)}` : 'never'}</td>
          <td>{summary(source)}</td>
          <td class="actions">
            {#if pending[source.sourceId]}
              <a href={`#/jobs/${pending[source.sourceId]}`}><span class={`status ${store.jobs[pending[source.sourceId]]?.status ?? 'queued'}`}>{store.jobs[pending[source.sourceId]]?.status ?? 'queued'}</span></a>
            {:else}
              {#if can('homelab.refresh')}<button class="secondary small" onclick={() => start('homelab.refresh', source.sourceId)}>Refresh</button>{/if}
              {#if can('homelab.investigate')}<button class="secondary small" onclick={() => start('homelab.investigate', source.sourceId)}>Investigate</button>{/if}
              {#if source.origin === 'registry' && can('homelab.update-source')}<a class="button small" href={`#/run/homelab.update-source?sourceId=${encodeURIComponent(source.sourceId)}`}>Edit</a>{/if}
            {/if}
          </td>
        </tr>
      {/each}
    </tbody>
  </table>
  {#if can('homelab.brief')}
    <p><a class="button" href="#/run/homelab.brief">Homelab brief</a></p>
  {/if}
{/if}

<style>
  .add { margin-bottom: 1.2rem; }
  .row { display: flex; gap: 0.5rem; flex-wrap: wrap; }
  .row input, .row select { width: auto; flex: 1; min-width: 10rem; }
  table { width: 100%; border-collapse: collapse; }
  th, td { text-align: left; padding: 0.5rem 0.6rem; border-bottom: 1px solid var(--line); vertical-align: top; }
  th { color: var(--muted); font-weight: 600; font-size: 0.85rem; }
  .actions { display: flex; gap: 0.4rem; align-items: center; }
  a.button { display: inline-block; border-radius: 6px; padding: 0.35rem 0.8rem; text-decoration: none; background: var(--accent); color: #fff; }
  a.button.small { padding: 0.2rem 0.6rem; font-size: 0.85rem; background: transparent; color: var(--text); border: 1px solid var(--line); }
</style>
