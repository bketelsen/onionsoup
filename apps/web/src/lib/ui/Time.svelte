<script lang="ts">
  import { store } from '../store.svelte.ts';
  import { ago, stamp } from '../format.ts';

  let { at }: { at: string } = $props();
</script>

<time datetime={at} title={stamp(at)}>{ago(at, store.now)}</time>
