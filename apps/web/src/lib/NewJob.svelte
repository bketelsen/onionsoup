<script lang="ts">
  import { store, type Capability } from './store.svelte.ts';

  /** Catalog sections, keyed by the capability ID prefix. Unlisted prefixes go under "Other". */
  const AREAS: Record<string, string> = {
    change: 'Changes',
    issue: 'Issues',
    code: 'Issues',
    investigation: 'Issues',
    repository: 'Repositories',
    homelab: 'Homelab',
    recipe: 'Recipes',
    models: 'Models',
  };
  const areaOf = (capability: Capability) => AREAS[capability.id.split('.')[0]] ?? 'Other';

  let search = $state('');
  const visible = $derived(store.capabilities.filter((c) => !search || `${c.id} ${c.description}`.toLowerCase().includes(search.toLowerCase())));
  const groups = $derived(Object.entries(Object.groupBy(visible, areaOf)) as [string, Capability[]][]);
</script>

<p class="crumbs"><a href="#/jobs">Jobs</a> / New job</p>
<h1>New job</h1>
{#if store.error}
  <p class="error">{store.error}</p>
{:else if !store.discovery}
  <p>Loading…</p>
{:else if store.capabilities.length === 0}
  <p>No capabilities are granted to <code>{store.discovery.invoker}</code>. Add them to the host configuration.</p>
{:else}
  <p class="muted">
    Pick what to run. Most of these are easier to ask for in <a href="#/">chat</a>.
    Running as <code>{store.discovery.invoker}</code>{#if store.discovery.remainingAdmissions !== null}{' '}· {store.discovery.remainingAdmissions} admissions left{/if}.
  </p>
  <label class="visually-hidden" for="capability-search">Search capabilities</label>
  <input id="capability-search" type="search" placeholder="Search capabilities" bind:value={search} />
  {#each groups as [area, capabilities] (area)}
    <h2>{area}</h2>
    <div class="grid">
      {#each capabilities as capability (capability.id)}
        <a class="card" href={`#/run/${capability.id}`}>
          <h3>{capability.id} <span class="version">{capability.version}</span>{#if capability.interactive}{' '}<span class="tag">needs you</span>{/if}</h3>
          <p>{capability.description}</p>
          <p class="effects">{#each capability.effects as effect}<span class="tag">{effect.replaceAll('_', ' ')}</span>{/each}</p>
        </a>
      {/each}
    </div>
  {/each}
{/if}

<style>
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 1rem; }
  .card { display: block; border: 1px solid var(--line); border-radius: 8px; padding: 1rem; color: inherit; text-decoration: none; background: var(--panel); }
  .card:hover { border-color: var(--accent); }
  h3 { font-size: 1.02rem; margin: 0 0 0.4rem; }
  .version { color: var(--muted); font-weight: 400; font-size: 0.8rem; }
  .effects { margin: 0.5rem 0 0; display: flex; flex-wrap: wrap; gap: 0.3rem; }
</style>
