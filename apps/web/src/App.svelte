<script lang="ts">
  import type { Component } from 'svelte';
  import RunCapability from './lib/RunCapability.svelte';
  import Jobs from './lib/Jobs.svelte';
  import JobDetail from './lib/JobDetail.svelte';
  import NewJob from './lib/NewJob.svelte';
  import RecipeEditor from './lib/recipes/RecipeEditor.svelte';
  import Chat from './lib/Chat.svelte';
  import Inbox from './lib/Inbox.svelte';
  import Homelab from './lib/Homelab.svelte';
  import Settings from './lib/Settings.svelte';
  import { store } from './lib/store.svelte.ts';
  import { inboxItems, jobsNeedingResults } from './lib/inbox.svelte.ts';

  type Section = 'chat' | 'inbox' | 'jobs' | 'homelab' | 'settings';
  type Route = { key: string; section: Section; view: Component<any>; props: Record<string, unknown>; isWide?: boolean };
  type Resolve = (parts: string[], prefill: Record<string, string>) => Route;

  const chat: Resolve = (parts) => ({ key: 'chat', section: 'chat', view: Chat, props: { id: parts[1] ?? '' }, isWide: true });
  /** Top-level hash segments and the view each opens. Unknown segments open chat. */
  const ROUTES: Record<string, Resolve> = {
    chat,
    inbox: () => ({ key: 'inbox', section: 'inbox', view: Inbox, props: {} }),
    homelab: () => ({ key: 'homelab', section: 'homelab', view: Homelab, props: {} }),
    jobs: (parts) => parts[1] === 'new' ? { key: 'new-job', section: 'jobs', view: NewJob, props: {} }
      : parts[1] ? { key: `job:${parts[1]}`, section: 'jobs', view: JobDetail, props: { id: parts[1] } }
      : { key: 'jobs', section: 'jobs', view: Jobs, props: {} },
    capabilities: () => ({ key: 'new-job', section: 'jobs', view: NewJob, props: {} }),
    run: (parts, prefill) => ({ key: `run:${parts.slice(1).join('/')}`, section: 'jobs', view: RunCapability, props: { id: decodeURIComponent(parts.slice(1).join('/')), prefill } }),
    settings: (parts) => ({ key: 'settings', section: 'settings', view: Settings, props: { tab: parts[1] ?? 'repositories' } }),
    recipes: (parts) => parts[1]
      ? { key: `recipe:${parts[1]}`, section: 'settings', view: RecipeEditor, props: { id: parts[1] }, isWide: true }
      : { key: 'settings', section: 'settings', view: Settings, props: { tab: 'recipes' } },
  };

  let hash = $state(location.hash || '#/');
  window.addEventListener('hashchange', () => {
    if (store.leaveGuard && !store.leaveGuard()) {
      history.replaceState(null, '', hash);
      return;
    }
    hash = location.hash || '#/';
  });

  const route = $derived.by(() => {
    const [pathPart, queryPart] = hash.replace(/^#\/?/, '').split('?');
    const parts = pathPart.split('/').filter(Boolean);
    const prefill = Object.fromEntries(new URLSearchParams(queryPart ?? ''));
    return (ROUTES[parts[0] ?? 'chat'] ?? chat)(parts, prefill);
  });
  const View = $derived(route.view);

  store.load();
  const hasHomelab = $derived(store.capabilities.some((capability) => capability.id.startsWith('homelab.')));
  $effect(() => { if (hasHomelab) store.loadSources().catch(() => {}); });

  // The inbox decides next steps from results, which the job list does not carry; read each once.
  const requested = new Set<string>();
  $effect(() => {
    for (const job of jobsNeedingResults()) {
      if (requested.has(job.jobId)) continue;
      requested.add(job.jobId);
      store.refresh(job.jobId).catch(() => {});
    }
  });
  const inboxCount = $derived(inboxItems().length);
  const activeCount = $derived(store.activeJobs.length);
</script>

<button type="button" class="skip" onclick={() => document.getElementById('main')?.focus()}>Skip to content</button>
<nav aria-label="Main">
  <a href="#/" class="brand">Onionsoup</a>
  <a href="#/" class:current={route.section === 'chat'} aria-current={route.section === 'chat' ? 'page' : undefined}>Chat</a>
  <a href="#/inbox" class:current={route.section === 'inbox'} aria-current={route.section === 'inbox' ? 'page' : undefined}>Inbox{#if inboxCount} <span class="badge" aria-label={`${inboxCount} items`}>{inboxCount}</span>{/if}</a>
  <a href="#/jobs" class:current={route.section === 'jobs'} aria-current={route.section === 'jobs' ? 'page' : undefined}>Jobs{#if activeCount} <span class="badge" aria-label={`${activeCount} running`}>{activeCount}</span>{/if}</a>
  {#if hasHomelab}<a href="#/homelab" class:current={route.section === 'homelab'} aria-current={route.section === 'homelab' ? 'page' : undefined}>Homelab</a>{/if}
  <span class="spacer"></span>
  {#if store.discovery?.login}<span class="muted login">{store.discovery.login}</span>{/if}
  <span class="connection" class:on={store.connected} role="status" aria-live="polite">
    <span class="dot" aria-hidden="true"></span>{store.connected ? '' : 'Offline'}
    <span class="visually-hidden">{store.connected ? 'Live updates connected' : ''}</span>
  </span>
  <a href="#/settings" class="gear" class:current={route.section === 'settings'} title="Settings" aria-label="Settings">
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"></path></svg>
  </a>
</nav>

<main id="main" tabindex="-1" class:wide={route.isWide}>
  {#key route.key}<View {...route.props} />{/key}
</main>

<style>
  nav { display: flex; align-items: center; gap: 1.2rem; padding: 0.7rem 1.2rem; border-bottom: 1px solid var(--line); background: var(--panel); }
  nav a { color: inherit; text-decoration: none; padding: 0.25rem 0; border-bottom: 2px solid transparent; white-space: nowrap; }
  nav a.current { border-bottom-color: var(--accent); }
  .brand { font-weight: 700; }
  .spacer { flex: 1; }
  .badge { background: var(--accent); color: #fff; border-radius: 999px; padding: 0 0.45rem; font-size: 0.75rem; }
  .connection { display: inline-flex; align-items: center; gap: 0.35rem; color: var(--danger); font-size: 0.85rem; }
  .dot { width: 0.6rem; height: 0.6rem; border-radius: 50%; background: var(--danger); }
  .connection.on .dot { background: var(--ok); }
  .gear { display: inline-flex; align-items: center; color: var(--muted); padding: 0.25rem; border-radius: 6px; border-bottom: 0; }
  .gear:hover, .gear.current { color: var(--accent); }
  main { max-width: 1100px; margin: 0 auto; padding: 1.2rem; }
  main.wide { max-width: none; }
  .skip { position: absolute; left: -9999px; background: var(--panel); color: var(--text); border: 1px solid var(--line); }
  .skip:focus { left: 1rem; top: 0.5rem; z-index: 10; }
  @media (max-width: 720px) {
    nav { gap: 0.8rem; padding: 0.6rem 16px; overflow-x: auto; }
    .brand, .login { display: none; }
    main { padding: 0.8rem 16px; }
  }
</style>
