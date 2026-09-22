<script lang="ts">
  /** A button that asks for a second click before it acts, instead of a browser dialog. */
  let { label, confirmLabel = `${label}?`, onconfirm, small = false, disabled = false }: {
    label: string; confirmLabel?: string; onconfirm: () => unknown; small?: boolean; disabled?: boolean;
  } = $props();

  /** How long the button waits for the second click. */
  const CONFIRM_MS = 4000;
  let isArmed = $state(false);
  let timer: ReturnType<typeof setTimeout> | undefined;

  function click() {
    if (!isArmed) {
      isArmed = true;
      timer = setTimeout(() => { isArmed = false; }, CONFIRM_MS);
      return;
    }
    clearTimeout(timer);
    isArmed = false;
    onconfirm();
  }
</script>

<button type="button" class="secondary" class:small class:armed={isArmed} {disabled} onclick={click} aria-live="polite">
  {isArmed ? `Click again: ${confirmLabel}` : label}
</button>

<style>
  .armed { border-color: var(--danger); color: var(--danger); }
</style>
