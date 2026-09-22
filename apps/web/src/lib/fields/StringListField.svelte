<script lang="ts">
  import type { FieldProps } from './types.ts';
  let { id, value = $bindable(), required }: FieldProps = $props();
  const text = $derived(Array.isArray(value) ? value.join('\n') : '');
</script>

<textarea {id} class="plain" rows={Math.min(8, Math.max(2, text.split('\n').length + 1))} {required} value={text} placeholder="one per line"
  oninput={(event) => { value = event.currentTarget.value.split(/[\n,]/).map((item) => item.trim()).filter(Boolean); }}></textarea>
