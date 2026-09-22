<script lang="ts">
  import { marked } from 'marked';
  import { store } from './store.svelte.ts';
  import { shortId } from './format.ts';

  let { source }: { source: string } = $props();

  const UUIDS = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;
  const REMOVED = 'script, style, iframe, object, embed, form, link, meta';

  // Rendered text comes from this host's own renderers, but it quotes issue text; strip anything active anyway.
  function sanitize(doc: Document) {
    for (const element of doc.querySelectorAll(REMOVED)) element.remove();
    for (const element of doc.body.querySelectorAll('*')) {
      for (const attribute of [...element.attributes]) {
        const name = attribute.name.toLowerCase();
        const value = attribute.value.trim().toLowerCase();
        const isActiveUrl = (name === 'href' || name === 'src') && (value.startsWith('javascript:') || value.startsWith('data:'));
        if (name.startsWith('on') || isActiveUrl) element.removeAttribute(attribute.name);
      }
      const isExternal = element.tagName === 'A' && !(element.getAttribute('href') ?? '').startsWith('#');
      if (isExternal) { element.setAttribute('rel', 'noopener noreferrer'); element.setAttribute('target', '_blank'); }
    }
  }

  function jobLink(doc: Document, jobId: string) {
    const link = doc.createElement('a');
    link.href = `#/jobs/${jobId}`;
    link.className = 'job-link';
    link.textContent = `${store.jobs[jobId].capability} ${shortId(jobId)}`;
    return link;
  }

  /** Replace IDs of jobs this browser knows with links to them; a code span holding only an ID becomes the link. */
  function linkJobs(doc: Document) {
    const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT);
    const texts: Text[] = [];
    while (walker.nextNode()) texts.push(walker.currentNode as Text);
    for (const text of texts) {
      if (text.parentElement?.closest('a')) continue;
      const ids = [...text.data.matchAll(UUIDS)].filter((match) => store.jobs[match[0]]);
      if (!ids.length) continue;
      const code = text.parentElement?.tagName === 'CODE' && text.data.trim() === ids[0][0] ? text.parentElement : undefined;
      if (code) { code.replaceWith(jobLink(doc, ids[0][0])); continue; }
      const parts: (string | Node)[] = [];
      let cursor = 0;
      for (const match of ids) {
        parts.push(text.data.slice(cursor, match.index), jobLink(doc, match[0]));
        cursor = match.index! + match[0].length;
      }
      parts.push(text.data.slice(cursor));
      text.replaceWith(...parts);
    }
  }

  function render(markdown: string) {
    const doc = new DOMParser().parseFromString(marked.parse(markdown, { async: false, gfm: true }) as string, 'text/html');
    sanitize(doc);
    linkJobs(doc);
    return doc.body.innerHTML;
  }

  const html = $derived(render(source));
</script>

<div class="markdown">{@html html}</div>

<style>
  .markdown :global(h1) { font-size: 1.3rem; margin: 1rem 0 0.5rem; }
  .markdown :global(h2) { font-size: 1.1rem; margin: 1.2rem 0 0.4rem; }
  .markdown :global(h3) { font-size: 1rem; margin: 1rem 0 0.3rem; }
  .markdown :global(pre) { max-height: 24rem; }
  .markdown :global(table) { border-collapse: collapse; margin: 0.5rem 0; display: block; overflow-x: auto; }
  .markdown :global(th), .markdown :global(td) { border: 1px solid var(--line); padding: 0.3rem 0.5rem; text-align: left; }
  .markdown :global(blockquote) { border-left: 3px solid var(--line); margin: 0.5rem 0; padding-left: 0.8rem; color: var(--muted); }
  .markdown :global(code) { background: var(--panel); padding: 0 0.25rem; border-radius: 3px; overflow-wrap: anywhere; }
  .markdown :global(pre code) { background: none; padding: 0; overflow-wrap: normal; }
  .markdown :global(.job-link) { border: 1px solid var(--line); border-radius: 999px; padding: 0 0.45rem; font-size: 0.85em; text-decoration: none; white-space: nowrap; }
</style>
