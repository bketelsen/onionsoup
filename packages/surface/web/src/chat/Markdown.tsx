import { memo, useMemo, type MouseEvent } from 'react';
import DOMPurify from 'dompurify';
import { Marked, type Tokens } from 'marked';

// Markdown as OpenChamber renders it (MIT, see ../../NOTICE): marked output inside `.markdown-content`, code blocks
// as a card with a language header, copy and wrap buttons and line numbers (chat/markdown/decorate.ts), inline code
// and tables marked up for the copied CSS. Highlighting is not done yet: code shows in the foreground colour.

const ICON_BUTTON = 'p-1 rounded hover:bg-interactive-hover/60 text-muted-foreground hover:text-foreground transition-colors';
const COPY_ICON = '<svg viewBox="0 0 24 24" class="size-3.5" fill="currentColor"><path d="M7 6V3a1 1 0 0 1 1-1h12a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1h-3v3c0 .552-.45 1-1.007 1H4.007A1.001 1.001 0 0 1 3 21l.003-14c0-.552.45-1 1.006-1H7zM5.002 8L5 20h10V8H5.002zM9 6h8v10h2V4H9v2z"/></svg>';
const WRAP_ICON = '<svg viewBox="0 0 24 24" class="size-3.5" fill="currentColor"><path d="M15 18h1.5a2.5 2.5 0 1 0 0-5H3v-2h13.5a4.5 4.5 0 1 1 0 9H15v2l-4-3 4-3v2zM3 4h18v2H3V4zm6 14v2H3v-2h6z"/></svg>';

function escape(text: string) {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

const marked = new Marked({ gfm: true, breaks: false });
marked.use({
  renderer: {
    code({ text, lang }: Tokens.Code) {
      const language = (lang ?? '').split(/\s/)[0] || 'text';
      const lines = text.replace(/\n$/, '').split('\n').map((line, index) =>
        `<span data-md-code-line><span data-md-code-line-number="${index + 1}"></span><span data-md-code-line-content>${escape(line) || ' '}</span></span>`).join('');
      return `<div data-component="markdown-code" class="my-4 group overflow-hidden rounded-2xl border border-border/80 bg-[var(--surface-elevated)]">
<div class="flex items-center justify-between border-b border-border/70 px-3 py-1.5"><span class="font-mono text-[13px] text-muted-foreground">${escape(language)}</span>
<div class="flex items-center gap-1" data-md-code-actions><button type="button" class="${ICON_BUTTON}" data-md-action="toggle-code-wrap" title="Wrap lines">${WRAP_ICON}</button><button type="button" class="${ICON_BUTTON}" data-md-action="copy-code" title="Copy">${COPY_ICON}</button></div></div>
<div data-md-code-body class="px-3 py-2.5 overflow-x-hidden"><pre class="min-w-0 w-full flex-1 whitespace-pre-wrap break-words" style="margin:0;background:transparent"><code>${lines}</code></pre></div></div>`;
    },
    codespan({ text }: Tokens.Codespan) {
      return `<code data-markdown="inline-code">${text}</code>`;
    },
    table(token: Tokens.Table) {
      const cell = (item: Tokens.TableCell, header: boolean) => {
        const tag = header ? 'th' : 'td';
        const style = header
          ? 'min-w-[120px] max-w-[320px] whitespace-normal [overflow-wrap:anywhere] border-r border-border/60 px-4 py-2.5 text-left align-middle font-semibold text-foreground last:border-r-0'
          : 'min-w-[120px] max-w-[320px] whitespace-normal [overflow-wrap:anywhere] border-r border-border/60 px-4 py-2.5 align-middle text-foreground/90 last:border-r-0';
        return `<${tag} class="${style}">${this.parser.parseInline(item.tokens)}</${tag}>`;
      };
      const head = `<tr class="border-b border-border/60">${token.header.map(item => cell(item, true)).join('')}</tr>`;
      const rows = token.rows.map((row, index) => `<tr class="${index === token.rows.length - 1 ? 'border-0' : 'border-b border-border/60'}">${row.map(item => cell(item, false)).join('')}</tr>`).join('');
      return `<div data-markdown="table-wrapper" class="group my-4 flex w-fit max-w-full flex-col"><div class="overflow-x-auto rounded-lg border border-border/80 bg-[var(--surface-elevated)]"><table data-markdown="table" class="w-max border-collapse text-sm"><thead>${head}</thead><tbody>${rows}</tbody></table></div></div>`;
    },
    link({ href, title, tokens }: Tokens.Link) {
      return `<a href="${escape(href)}"${title ? ` title="${escape(title)}"` : ''} target="_blank" rel="noreferrer noopener">${this.parser.parseInline(tokens)}</a>`;
    },
  },
});

export function renderMarkdown(text: string) {
  return DOMPurify.sanitize(marked.parse(text, { async: false }) as string, { ADD_ATTR: ['target', 'data-md-action', 'data-md-code-line-number', 'data-md-code-line', 'data-md-code-line-content', 'data-md-code-body', 'data-md-code-actions', 'data-component', 'data-markdown'] });
}

/** Copy and wrap buttons on code blocks, handled once for the whole rendered block. */
function onMarkdownClick(event: MouseEvent<HTMLDivElement>) {
  const button = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-md-action]');
  if (!button) return;
  const block = button.closest('[data-component="markdown-code"]');
  const body = block?.querySelector<HTMLElement>('[data-md-code-body]');
  if (!block || !body) return;
  if (button.dataset.mdAction === 'copy-code') {
    const text = [...block.querySelectorAll('[data-md-code-line-content]')].map(line => line.textContent ?? '').join('\n');
    void navigator.clipboard.writeText(text);
    button.style.color = 'var(--status-success)';
    setTimeout(() => { button.style.color = ''; }, 2000);
  } else {
    const pre = body.querySelector('pre');
    const wrapped = pre?.classList.toggle('whitespace-pre-wrap');
    pre?.classList.toggle('break-words', wrapped);
    body.classList.toggle('overflow-x-hidden', wrapped);
    body.classList.toggle('overflow-x-auto', !wrapped);
  }
}

export const Markdown = memo(function Markdown({ text, variant = 'assistant', className }: { text: string; variant?: 'assistant' | 'reasoning' | 'tool'; className?: string }) {
  const html = useMemo(() => renderMarkdown(text), [text]);
  const inner = variant === 'tool' ? 'markdown-content markdown-tool' : variant === 'reasoning' ? 'markdown-content markdown-reasoning' : 'markdown-content leading-relaxed';
  return (
    <div className={`break-words w-full min-w-0 ${className ?? ''}`} onClick={onMarkdownClick}>
      <div className={inner} data-markdown-content dangerouslySetInnerHTML={{ __html: html }} />
    </div>
  );
});
