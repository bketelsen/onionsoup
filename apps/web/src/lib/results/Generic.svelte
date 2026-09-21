<script lang="ts">
  import Markdown from '../Markdown.svelte';

  let { result }: { result: unknown } = $props();
  const markdown = $derived.by(() => {
    const r = result as Record<string, unknown> | null;
    return r && typeof r.markdown === 'string' ? (r.markdown as string) : undefined;
  });
</script>

{#if markdown}
  <Markdown source={markdown} />
{:else}
  <pre>{JSON.stringify(result, null, 2)}</pre>
{/if}
