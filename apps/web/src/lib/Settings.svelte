<script lang="ts">
  import type { Component } from 'svelte';
  import Capabilities from './Capabilities.svelte';
  import Recipes from './recipes/Recipes.svelte';
  import Models from './Models.svelte';
  import Repositories from './Repositories.svelte';
  import Sources from './Sources.svelte';

  let { tab }: { tab: string } = $props();

  /** Settings sections, keyed by the hash segment that opens them. */
  const sections: Record<string, { label: string; view: Component }> = {
    repositories: { label: 'Repositories', view: Repositories },
    sources: { label: 'Homelab sources', view: Sources },
    models: { label: 'Models', view: Models },
    capabilities: { label: 'Capabilities', view: Capabilities },
    recipes: { label: 'Recipes', view: Recipes },
  };
  const current = $derived(sections[tab] ?? sections.repositories);
  const View = $derived(current.view);
</script>

<div class="settings">
  <aside class="tabs">
    <h1>Settings</h1>
    {#each Object.entries(sections) as [key, section] (key)}
      <a href={`#/settings/${key}`} class:current={section === current}>{section.label}</a>
    {/each}
  </aside>
  <section class="content">
    <View />
  </section>
</div>

<style>
  .settings { display: grid; grid-template-columns: 200px 1fr; gap: 1.5rem; align-items: start; }
  .tabs { display: grid; gap: 0.2rem; position: sticky; top: 1rem; }
  .tabs h1 { font-size: 1.1rem; margin: 0 0 0.6rem; }
  .tabs a { color: inherit; text-decoration: none; padding: 0.4rem 0.6rem; border-radius: 6px; }
  .tabs a.current { background: var(--panel); border: 1px solid var(--line); }
  .content { min-width: 0; }
  .content :global(h1) { font-size: 1.3rem; }
  @media (max-width: 720px) { .settings { grid-template-columns: 1fr; } .tabs { position: static; grid-auto-flow: column; } }
</style>
