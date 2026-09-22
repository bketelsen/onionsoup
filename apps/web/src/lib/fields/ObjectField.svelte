<script lang="ts">
  import SchemaForm from '../SchemaForm.svelte';
  import type { FieldProps } from './types.ts';
  let { id, schema, value = $bindable() }: FieldProps = $props();
  const required = $derived(new Set(schema.required ?? []));
  const fields = $derived(value as Record<string, unknown>);
</script>

<div class="object">
  {#each Object.entries(schema.properties ?? {}) as [key, child] (key)}
    <SchemaForm schema={child} bind:value={fields[key]} path={id ? `${id}.${key}` : key} name={key} required={required.has(key)} />
  {/each}
</div>

<style>
  .object { display: grid; gap: 0.9rem; }
</style>
