<script lang="ts">
  import RunCapability from './lib/RunCapability.svelte';
  import Jobs from './lib/Jobs.svelte';
  import JobDetail from './lib/JobDetail.svelte';
  import RecipeEditor from './lib/recipes/RecipeEditor.svelte';
  import Chat from './lib/Chat.svelte';
  import Settings from './lib/Settings.svelte';
  import { store } from './lib/store.svelte.ts';

  let hash = $state(location.hash || '#/');
  window.addEventListener('hashchange', () => { hash = location.hash || '#/'; });

  const route = $derived.by(() => {
    const [pathPart, queryPart] = hash.replace(/^#\/?/, '').split('?');
    const parts = pathPart.split('/').filter(Boolean);
    const prefill = Object.fromEntries(new URLSearchParams(queryPart ?? ''));
    const page = parts[0] ?? 'chat';
    if (page === 'run' && parts[1]) return { page: 'run', id: decodeURIComponent(parts.slice(1).join('/')), prefill };
    if (page === 'jobs' && parts[1]) return { page: 'job', id: parts[1], prefill };
    if (page === 'jobs') return { page: 'jobs', id: '', prefill };
    if (page === 'recipes' && parts[1]) return { page: 'recipe', id: parts[1], prefill };
    if (page === 'settings') return { page: 'settings', id: parts[1] ?? 'capabilities', prefill };
    if (page === 'recipes' || page === 'capabilities') return { page: 'settings', id: page, prefill };
    if (page === 'chat') return { page: 'chat', id: parts[1] ?? '', prefill };
    return { page: 'chat', id: '', prefill };
  });

  store.load();
  const active = $derived(store.jobList.filter((j) => j.status === 'queued' || j.status === 'running').length);
</script>

<nav>
  <a href="#/" class="brand">Onionsoup</a>
  <a href="#/" class:current={route.page === 'chat'}>Chat</a>
  <a href="#/jobs" class:current={route.page === 'jobs' || route.page === 'job'}>Jobs{#if active} <span class="badge">{active}</span>{/if}</a>
  <span class="spacer"></span>
  {#if store.discovery?.login}<span class="muted">{store.discovery.login}</span>{/if}
  <span class="dot" class:on={store.connected} title={store.connected ? 'Live updates connected' : 'Live updates disconnected'}></span>
  <a href="#/settings" class="gear" class:current={['settings', 'run', 'recipe'].includes(route.page)} title="Settings" aria-label="Settings">
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"></path></svg>
  </a>
</nav>

<main class:wide={route.page === 'recipe' || route.page === 'chat'}>
  {#if route.page === 'run'}
    <RunCapability id={route.id} prefill={route.prefill} />
  {:else if route.page === 'job'}
    <JobDetail id={route.id} />
  {:else if route.page === 'jobs'}
    <Jobs />
  {:else if route.page === 'settings'}
    <Settings tab={route.id} />
  {:else if route.page === 'recipe'}
    {#key route.id}<RecipeEditor id={route.id} />{/key}
  {:else}
    <Chat id={route.id} />
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
  .gear { display: inline-flex; align-items: center; color: var(--muted); padding: 0.25rem; border-radius: 6px; border-bottom: 0; }
  .gear:hover, .gear.current { color: var(--accent); }
  main { max-width: 1100px; margin: 0 auto; padding: 1.2rem; }
  main.wide { max-width: none; }
</style>
