<script lang="ts">
  import { explain } from '../reasons.ts';

  let { error }: { error: string } = $props();
  const reason = $derived(explain(error));
</script>

<div class="error-text" role="alert">
  <p class="error">
    {#if reason.step}<strong>Step {reason.step}:</strong>{/if}
    {reason.meaning}
    {#if !reason.isUnexpected}<span class="tag">{reason.code}</span>{/if}
  </p>
  {#if reason.detail && !reason.isUnexpected}<p class="muted detail">{reason.detail}</p>{/if}
  {#if reason.isUnexpected}
    <details><summary>Original error</summary><pre>{reason.detail}</pre></details>
  {/if}
</div>

<style>
  .error-text p { margin: 0.2rem 0; }
  .detail { white-space: pre-wrap; }
</style>
