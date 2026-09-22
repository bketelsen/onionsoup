<script lang="ts">
  import { untrack } from 'svelte';
  import type { FieldProps } from './types.ts';
  let { id, value = $bindable() }: FieldProps = $props();

  let text = $state(untrack(() => (value === undefined ? '' : JSON.stringify(value, null, 2))));
  let isInvalid = $state(false);

  function parse(next: string) {
    text = next;
    isInvalid = false;
    if (!next.trim()) { value = undefined; return; }
    try { value = JSON.parse(next); } catch { isInvalid = true; }
  }
</script>

<textarea {id} rows="4" value={text} oninput={(event) => parse(event.currentTarget.value)} placeholder="JSON"></textarea>
{#if isInvalid}<small class="error">Not valid JSON</small>{/if}
