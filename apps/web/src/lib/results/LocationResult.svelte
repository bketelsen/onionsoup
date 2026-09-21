<script lang="ts">
  import Location from './Location.svelte';

  let { result }: { result: unknown } = $props();
  const h = $derived((result as { handoff: any }).handoff);
</script>

<Location run={h.location} repository={h.repository} disposition={h.disposition} reason={h.reason} />
