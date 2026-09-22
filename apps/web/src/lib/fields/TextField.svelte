<script lang="ts">
  import type { FieldProps } from './types.ts';
  let { id, schema, value = $bindable(), required }: FieldProps = $props();
  /** Long text limits get a text area. */
  const LONG_TEXT = 300;
  const isLong = $derived((schema.maxLength ?? 0) > LONG_TEXT);
</script>

{#if isLong}
  <textarea {id} class="plain" rows="4" bind:value maxlength={schema.maxLength} {required}></textarea>
{:else}
  <input {id} type="text" bind:value maxlength={schema.maxLength} pattern={schema.pattern} {required} />
{/if}
