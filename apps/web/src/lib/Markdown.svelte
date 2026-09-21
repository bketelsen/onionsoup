<script lang="ts">
  import { marked } from 'marked';

  let { source }: { source: string } = $props();

  // Rendered text comes from this host's own renderers, but it quotes issue text; strip anything active anyway.
  function sanitize(html: string) {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    for (const el of doc.querySelectorAll('script, style, iframe, object, embed, form, link, meta')) el.remove();
    for (const el of doc.body.querySelectorAll('*')) {
      for (const attr of [...el.attributes]) {
        const name = attr.name.toLowerCase();
        const value = attr.value.trim().toLowerCase();
        if (name.startsWith('on') || ((name === 'href' || name === 'src') && (value.startsWith('javascript:') || value.startsWith('data:')))) el.removeAttribute(attr.name);
      }
      if (el.tagName === 'A') { el.setAttribute('rel', 'noopener noreferrer'); el.setAttribute('target', '_blank'); }
    }
    return doc.body.innerHTML;
  }

  const html = $derived(sanitize(marked.parse(source, { async: false, gfm: true }) as string));
</script>

<div class="markdown">{@html html}</div>

<style>
  .markdown :global(h1) { font-size: 1.3rem; margin: 1rem 0 0.5rem; }
  .markdown :global(h2) { font-size: 1.1rem; margin: 1.2rem 0 0.4rem; }
  .markdown :global(h3) { font-size: 1rem; margin: 1rem 0 0.3rem; }
  .markdown :global(pre) { max-height: 24rem; }
  .markdown :global(table) { border-collapse: collapse; margin: 0.5rem 0; }
  .markdown :global(th), .markdown :global(td) { border: 1px solid var(--line); padding: 0.3rem 0.5rem; text-align: left; }
  .markdown :global(blockquote) { border-left: 3px solid var(--line); margin: 0.5rem 0; padding-left: 0.8rem; color: var(--muted); }
  .markdown :global(code) { background: var(--panel); padding: 0 0.25rem; border-radius: 3px; }
  .markdown :global(pre code) { background: none; padding: 0; }
</style>
