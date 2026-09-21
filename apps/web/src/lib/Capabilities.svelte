<script lang="ts">
  import { store } from './store.svelte.ts';

  const running = $derived(store.jobList.filter((j) => j.status === 'queued' || j.status === 'running'));
</script>

<h1>Capabilities</h1>
{#if store.error}
  <p class="error">{store.error}</p>
{:else if !store.discovery}
  <p>Loading…</p>
{:else if store.capabilities.length === 0}
  <p>No capabilities are granted to <code>{store.discovery.invoker}</code>. Add them to the host configuration.</p>
{:else}
  <p class="muted">
    Invoker <code>{store.discovery.invoker}</code>
    {#if store.discovery.remainingAdmissions !== null} · {store.discovery.remainingAdmissions} admissions left{/if}
    {#if running.length} · {running.length} active{/if}
  </p>
  <div class="grid">
    {#each store.capabilities as c (c.id)}
      <a class="card" href={`#/run/${c.id}`}>
        <h2>{c.id} <span class="version">{c.version}</span>{#if c.id.startsWith('recipe.')} <span class="tag">recipe</span>{/if}</h2>
        <p>{c.description}</p>
        <p class="effects">{#each c.effects as effect}<span class="tag">{effect.replaceAll('_', ' ')}</span>{/each}</p>
      </a>
    {/each}
  </div>
{/if}

<style>
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 1rem; }
  .card { display: block; border: 1px solid var(--line); border-radius: 8px; padding: 1rem; color: inherit; text-decoration: none; background: var(--panel); }
  .card:hover { border-color: var(--accent); }
  h2 { font-size: 1.05rem; margin: 0 0 0.4rem; }
  .version { color: var(--muted); font-weight: 400; font-size: 0.8rem; }
  .effects { margin: 0.5rem 0 0; display: flex; flex-wrap: wrap; gap: 0.3rem; }
</style>
