<script lang="ts">
  import Capabilities from './lib/Capabilities.svelte';
  import RunCapability from './lib/RunCapability.svelte';
  import Jobs from './lib/Jobs.svelte';
  import JobDetail from './lib/JobDetail.svelte';
  import Recipes from './lib/recipes/Recipes.svelte';
  import RecipeEditor from './lib/recipes/RecipeEditor.svelte';
  import Chat from './lib/Chat.svelte';
  import { store } from './lib/store.svelte.ts';

  let hash = $state(location.hash || '#/');
  window.addEventListener('hashchange', () => { hash = location.hash || '#/'; });

  const route = $derived.by(() => {
    const [pathPart, queryPart] = hash.replace(/^#\/?/, '').split('?');
    const parts = pathPart.split('/').filter(Boolean);
    const prefill = Object.fromEntries(new URLSearchParams(queryPart ?? ''));
    if (parts[0] === 'run' && parts[1]) return { page: 'run', id: decodeURIComponent(parts.slice(1).join('/')), prefill };
    if (parts[0] === 'jobs' && parts[1]) return { page: 'job', id: parts[1], prefill };
    if (parts[0] === 'jobs') return { page: 'jobs', id: '', prefill };
    if (parts[0] === 'recipes' && parts[1]) return { page: 'recipe', id: parts[1], prefill };
    if (parts[0] === 'recipes') return { page: 'recipes', id: '', prefill };
    if (parts[0] === 'chat') return { page: 'chat', id: parts[1] ?? '', prefill };
    return { page: 'capabilities', id: '', prefill };
  });

  store.load();
  const active = $derived(store.jobList.filter((j) => j.status === 'queued' || j.status === 'running').length);
</script>

<nav>
  <a href="#/" class="brand">Onionsoup</a>
  <a href="#/" class:current={route.page === 'capabilities' || route.page === 'run'}>Capabilities</a>
  <a href="#/jobs" class:current={route.page === 'jobs' || route.page === 'job'}>Jobs{#if active} <span class="badge">{active}</span>{/if}</a>
  <a href="#/recipes" class:current={route.page === 'recipes' || route.page === 'recipe'}>Recipes</a>
  <a href="#/chat" class:current={route.page === 'chat'}>Chat</a>
  <span class="spacer"></span>
  {#if store.discovery?.login}<span class="muted">{store.discovery.login}</span>{/if}
  <span class="dot" class:on={store.connected} title={store.connected ? 'Live updates connected' : 'Live updates disconnected'}></span>
</nav>

<main class:wide={route.page === 'recipe' || route.page === 'chat'}>
  {#if route.page === 'run'}
    <RunCapability id={route.id} prefill={route.prefill} />
  {:else if route.page === 'job'}
    <JobDetail id={route.id} />
  {:else if route.page === 'jobs'}
    <Jobs />
  {:else if route.page === 'recipes'}
    <Recipes />
  {:else if route.page === 'chat'}
    <Chat id={route.id} />
  {:else if route.page === 'recipe'}
    {#key route.id}<RecipeEditor id={route.id} />{/key}
  {:else}
    <Capabilities />
  {/if}
</main>

<style>
  nav { display: flex; align-items: center; gap: 1.2rem; padding: 0.7rem 1.2rem; border-bottom: 1px solid var(--line); background: var(--panel); }
  nav a { color: inherit; text-decoration: none; padding: 0.25rem 0; border-bottom: 2px solid transparent; }
  nav a.current { border-bottom-color: var(--accent); }
  .brand { font-weight: 700; }
  .spacer { flex: 1; }
  .badge { background: var(--accent); color: white; border-radius: 999px; padding: 0 0.45rem; font-size: 0.75rem; }
  .dot { width: 0.6rem; height: 0.6rem; border-radius: 50%; background: var(--danger); }
  .dot.on { background: var(--ok); }
  main { max-width: 1100px; margin: 0 auto; padding: 1.2rem; }
  main.wide { max-width: none; }
</style>
