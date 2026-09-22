<script lang="ts">
  import Time from './ui/Time.svelte';
  import { dismiss, inboxItems, INBOX_KINDS, INBOX_LIMITS, type InboxKind } from './inbox.svelte.ts';

  /** `limit` shows a short list without headings, as chat does; the full page groups every item by kind. */
  let { limit }: { limit?: number } = $props();

  const HEADINGS: Record<InboxKind, string> = {
    next: 'Waiting on you',
    attention: 'Homelab attention',
    failed: 'Failed',
    stale: 'Not observed recently',
  };
  const items = $derived(inboxItems());
  const shown = $derived(limit ? items.slice(0, limit) : items);
  const groups = $derived(INBOX_KINDS.map((kind) => [kind, shown.filter((item) => item.kind === kind)] as const).filter(([, list]) => list.length));
</script>

{#if !limit}
  <h1>Inbox</h1>
  <p class="muted">Things that need a person: next steps waiting on you, failures nobody retried, and homelab sources to look at. Covers the last {INBOX_LIMITS.days} days.</p>
{/if}

{#if items.length === 0}
  {#if !limit}<p>Nothing needs you right now.</p>{/if}
{:else}
  {#each groups as [kind, list] (kind)}
    {#if !limit}<h2>{HEADINGS[kind]} <span class="muted">{list.length}</span></h2>{/if}
    <ul class="items">
      {#each list as item (item.key)}
        <li class={`item ${item.kind}`}>
          <div class="text">
            <a href={item.href}>{item.title}</a>
            <div class="muted small">{item.detail} · <Time at={item.at} /></div>
          </div>
          <div class="buttons">
            {#if item.action}<a class="button small" href={item.action.href}>{item.action.label}</a>{/if}
            <button type="button" class="secondary small" onclick={() => dismiss(item.key)} aria-label={`Dismiss ${item.title}`}>Dismiss</button>
          </div>
        </li>
      {/each}
    </ul>
  {/each}
  {#if limit && items.length > limit}<p class="small"><a href="#/inbox">{items.length - limit} more in the inbox</a></p>{/if}
{/if}

<style>
  .items { list-style: none; padding: 0; margin: 0 0 1rem; display: grid; gap: 0.5rem; }
  .item { display: flex; gap: 0.8rem; align-items: center; justify-content: space-between; flex-wrap: wrap; background: var(--panel); border: 1px solid var(--line); border-left-width: 3px; border-radius: 6px; padding: 0.5rem 0.8rem; }
  .item.next { border-left-color: var(--accent); }
  .item.attention { border-left-color: var(--warn); }
  .item.failed { border-left-color: var(--danger); }
  .item.stale { border-left-color: var(--muted); }
  .text { min-width: 0; overflow-wrap: anywhere; }
  .text a { color: inherit; font-weight: 600; text-decoration: none; }
  .buttons { display: flex; gap: 0.4rem; }
  .small { font-size: 0.82rem; }
</style>
