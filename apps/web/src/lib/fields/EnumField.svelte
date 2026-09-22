<script lang="ts">
  import type { FieldProps } from './types.ts';
  let { id, schema, value = $bindable(), required }: FieldProps = $props();
</script>

<select {id} bind:value {required}>
  {#each schema.enum ?? [] as option}
    <option value={option}>{String(option)}</option>
  {/each}
</select>
