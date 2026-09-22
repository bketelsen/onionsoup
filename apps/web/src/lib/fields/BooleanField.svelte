<script lang="ts">
  import type { FieldProps } from './types.ts';
  let { id, value = $bindable() }: FieldProps = $props();
</script>

<input {id} type="checkbox" bind:checked={value as boolean} />
