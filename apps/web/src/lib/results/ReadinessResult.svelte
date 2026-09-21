<script lang="ts">
  import Readiness from './Readiness.svelte';

  let { result }: { result: unknown } = $props();
  const r = $derived(result as { run: any; issue: any });
</script>

<Readiness run={r.run} issue={r.issue} />
