<script lang="ts">
  type Match = { path: string; line: number; text: string };
  let { result }: { result: unknown } = $props();
  const search = $derived(result as { repository: string; commit: string; query: string; matches: Match[]; truncated: boolean });
  const link = (match: Match) => `https://github.com/${search.repository}/blob/${search.commit}/${match.path}#L${match.line}`;
</script>

<p>{search.matches.length} match{search.matches.length === 1 ? '' : 'es'} for <code>{search.query}</code> in {search.repository}{#if search.truncated}{' '}<span class="tag">truncated</span>{/if}</p>
<ul class="matches">
  {#each search.matches as match}
    <li><a href={link(match)} target="_blank" rel="noopener noreferrer"><code>{match.path}:{match.line}</code></a><pre>{match.text}</pre></li>
  {/each}
</ul>

<style>
  .matches { list-style: none; padding: 0; display: grid; gap: 0.5rem; }
  .matches pre { margin: 0.2rem 0 0; max-height: 6rem; }
</style>
