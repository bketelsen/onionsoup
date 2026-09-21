<script lang="ts" module>
  import type { Component } from 'svelte';
  import Generic from './Generic.svelte';
  import ReadinessResult from './ReadinessResult.svelte';
  import LocationResult from './LocationResult.svelte';
  import Packet from './Packet.svelte';
  import RecipeRun from './RecipeRun.svelte';

  type Renderer = Component<{ result: unknown }>;

  /** Exact capability IDs first, then ID prefixes; anything else gets Markdown or JSON. */
  const byId: Record<string, Renderer> = {
    'issue.readiness': ReadinessResult,
    'code.location': LocationResult,
    'investigation.packet': Packet,
  };
  const byPrefix: [string, Renderer][] = [['recipe.', RecipeRun]];

  export function rendererFor(capability: string): Renderer {
    return byId[capability] ?? byPrefix.find(([prefix]) => capability.startsWith(prefix))?.[1] ?? Generic;
  }
</script>

<script lang="ts">
  let { capability, result }: { capability: string; result: unknown } = $props();
  const View = $derived(rendererFor(capability));
</script>

<View {result} />
