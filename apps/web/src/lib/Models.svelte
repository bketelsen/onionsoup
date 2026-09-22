<script lang="ts">
  import { store, ApiError, type AgentModel, type ModelChoice, type ProviderCatalog } from './store.svelte.ts';

  let error = $state<string | null>(null);
  let refreshing = $state(false);
  /** Assignment jobs still running, by agent. */
  let pending = $state<Record<string, string>>({});

  $effect(() => { store.loadModels().catch((e) => { error = String(e); }); });
  $effect(() => {
    for (const [agent, jobId] of Object.entries(pending)) {
      const job = store.jobs[jobId];
      if (!job || job.status === 'queued' || job.status === 'running') continue;
      if (job.error) error = `${agent}: ${job.error}`;
      delete pending[agent];
      store.loadModels().catch(() => {});
    }
  });

  const canAssign = $derived(Boolean(store.capability('models.assign')));
  const catalogs = $derived(store.models?.catalogs ?? []);
  const key = (choice: ModelChoice) => `${choice.provider}/${choice.model}`;
  const listed = (choice: ModelChoice) => catalogs.some((c) => c.provider === choice.provider && c.status === 'ok' && c.models.some((m) => m.id === choice.model));

  /** What each catalog state says about a provider, keyed by status. */
  const catalogLabel: Record<ProviderCatalog['status'], (catalog: ProviderCatalog) => string> = {
    ok: (catalog) => (catalog.status === 'ok' ? `${catalog.models.length} models` : ''),
    signed_out: () => 'signed out',
    unavailable: (catalog) => (catalog.status === 'unavailable' ? `unavailable (${catalog.reason})` : ''),
  };
  const originLabel: Record<AgentModel['origin'], string> = { assigned: 'set here', config: 'host config', default: 'config default' };

  async function submit(agent: string, choice?: ModelChoice) {
    error = null;
    try {
      pending[agent] = await store.submit('models.assign', choice ? { agent, choice } : { agent });
    } catch (e) {
      error = e instanceof ApiError ? e.message : String(e);
    }
  }
  function choose(row: AgentModel, value: string) {
    const [provider, ...rest] = value.split('/');
    const choice = { provider, model: rest.join('/') } as ModelChoice;
    if (key(choice) !== key(row.choice)) void submit(row.agent, choice);
  }
  async function refresh() {
    refreshing = true;
    error = null;
    try { await store.loadModels(true); } catch (e) { error = String(e); } finally { refreshing = false; }
  }
</script>

<h1>Models</h1>
<p class="muted">Each agent runs on its own provider and model. The host config sets defaults; choices made here override them and apply to the next run. Only models a signed-in provider lists can be chosen.</p>

<div class="catalogs">
  {#each catalogs as catalog (catalog.provider)}
    <span class={`catalog ${catalog.status}`}><strong>{catalog.provider}</strong> {catalogLabel[catalog.status](catalog)}</span>
  {/each}
  <button class="secondary small" onclick={refresh} disabled={refreshing}>{refreshing ? 'Asking providers…' : 'Refresh catalogs'}</button>
  {#if store.models}<small class="muted">listed {new Date(store.models.catalogsAt).toLocaleString()}</small>{/if}
</div>
{#if error}<p class="error">{error}</p>{/if}
{#if store.models && !store.models.persisted}<p class="muted">This host does not persist assignments; edit the host config instead.</p>{/if}

{#if store.models}
  <table class="list">
    <thead><tr><th>Agent</th><th>Model</th><th>From</th><th></th></tr></thead>
    <tbody>
      {#each store.models.agents as row (row.agent)}
        <tr>
          <td data-label="Agent"><strong>{row.agent}</strong><br /><small class="muted">{row.description}</small></td>
          <td data-label="Model">
            {#if canAssign && store.models.persisted}
              <select aria-label={`Model for ${row.agent}`} value={key(row.choice)} disabled={Boolean(pending[row.agent])} onchange={(e) => choose(row, e.currentTarget.value)}>
                {#if !listed(row.choice)}<option value={key(row.choice)}>{key(row.choice)} (not listed)</option>{/if}
                {#each catalogs as catalog (catalog.provider)}
                  {#if catalog.status === 'ok'}
                    <optgroup label={catalog.provider}>
                      {#each catalog.models as model (model.id)}
                        <option value={`${catalog.provider}/${model.id}`}>{catalog.provider} · {model.name}</option>
                      {/each}
                    </optgroup>
                  {/if}
                {/each}
              </select>
            {:else}
              <code>{key(row.choice)}</code>
            {/if}
            {#if !listed(row.choice)}<br /><small class="warn">Not in a signed-in provider's catalog; runs may fail.</small>{/if}
          </td>
          <td data-label="From"><span class="tag">{originLabel[row.origin]}</span></td>
          <td class="actions">
            {#if pending[row.agent]}
              <a href={`#/jobs/${pending[row.agent]}`}><span class={`status ${store.jobs[pending[row.agent]]?.status ?? 'queued'}`}>{store.jobs[pending[row.agent]]?.status ?? 'queued'}</span></a>
            {:else if row.origin === 'assigned' && canAssign}
              <button class="secondary small" title={`Back to ${key(row.configured)}`} onclick={() => submit(row.agent)}>Reset</button>
            {/if}
          </td>
        </tr>
      {/each}
    </tbody>
  </table>
{:else if !error}
  <p class="muted">Loading…</p>
{/if}

<style>
  .catalogs { display: flex; gap: 0.6rem; align-items: center; flex-wrap: wrap; margin-bottom: 1rem; }
  .catalog { border: 1px solid var(--line); border-radius: 999px; padding: 0.1rem 0.7rem; font-size: 0.85rem; }
  .catalog.ok { border-color: var(--ok); }
  .catalog.signed_out { color: var(--muted); }
  .catalog.unavailable { border-color: var(--warn); }
  .warn { color: var(--warn); }
  td select { width: min(100%, 22rem); }
  .actions, .tag { white-space: nowrap; }
</style>
