import { createCssVariablesTheme, createHighlighterCore, type HighlighterCore } from 'shiki/core';
import { createJavaScriptRegexEngine } from 'shiki/engine/javascript';
import { bundledLanguages, bundledLanguagesAlias } from 'shiki/langs';

// Code highlighting with shiki, as OpenChamber does, coloured through CSS variables so light and dark themes need no
// re-highlighting: shiki's css-variables theme maps onto the theme's --syntax-* colours (see styles/chat.css).
// Languages load on demand; anything unknown stays plain.

const theme = createCssVariablesTheme({ name: 'onionsoup', variablePrefix: '--shiki-', fontStyle: true });
let highlighter: Promise<HighlighterCore> | undefined;
const loading = new Map<string, Promise<boolean>>();
const cache = new Map<string, string[]>();

function instance() {
  highlighter ??= createHighlighterCore({ themes: [theme], langs: [], engine: createJavaScriptRegexEngine({ forgiving: true }) });
  return highlighter;
}

const ALIASES: Record<string, string> = { sh: 'bash', shell: 'bash', zsh: 'bash', console: 'bash', ts: 'typescript', js: 'javascript', yml: 'yaml', py: 'python', rs: 'rust', golang: 'go', dockerfile: 'docker', text: '', plaintext: '', txt: '' };

function resolve(language: string) {
  const lower = language.toLowerCase();
  const name = ALIASES[lower] ?? lower;
  if (!name) return undefined;
  const aliases = bundledLanguagesAlias as Record<string, unknown>;
  if (name in bundledLanguages) return name;
  if (name in aliases) return name;
  return undefined;
}

async function ensure(language: string) {
  let pending = loading.get(language);
  if (!pending) {
    const importer = (bundledLanguages as Record<string, () => Promise<{ default: unknown }>>)[language]
      ?? (bundledLanguagesAlias as Record<string, () => Promise<{ default: unknown }>>)[language];
    pending = importer
      ? instance().then(async core => { await core.loadLanguage((await importer()).default as never); return true; }).catch(() => false)
      : Promise.resolve(false);
    loading.set(language, pending);
  }
  return pending;
}

function escape(text: string) {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Highlighted HTML for each line of `code`, or undefined when the language is unknown. */
export async function highlightLines(code: string, language: string): Promise<string[] | undefined> {
  const resolved = resolve(language);
  if (!resolved || !(await ensure(resolved))) return undefined;
  const key = `${resolved}\u0000${code}`;
  const known = cache.get(key);
  if (known) return known;
  const core = await instance();
  const lines = core.codeToTokensBase(code, { lang: resolved, theme: 'onionsoup' }).map(tokens => tokens.map(token => {
    const style = [token.color ? `color:${token.color}` : '', token.fontStyle && token.fontStyle & 1 ? 'font-style:italic' : '', token.fontStyle && token.fontStyle & 2 ? 'font-weight:600' : ''].filter(Boolean).join(';');
    return style ? `<span style="${style}">${escape(token.content)}</span>` : escape(token.content);
  }).join(''));
  if (cache.size > 500) cache.clear();
  cache.set(key, lines);
  return lines;
}

/** Highlight every markdown code block under `root` whose language is known, in place. */
export function highlightCodeBlocks(root: HTMLElement) {
  for (const block of root.querySelectorAll<HTMLElement>('[data-component="markdown-code"][data-lang]')) {
    const language = block.dataset.lang ?? '';
    const contents = [...block.querySelectorAll<HTMLElement>('[data-md-code-line-content]')];
    const code = contents.map(line => line.textContent ?? '').join('\n');
    void highlightLines(code, language).then(lines => {
      if (!lines || !block.isConnected) return;
      contents.forEach((line, index) => { if (lines[index] !== undefined) line.innerHTML = lines[index] || ' '; });
    });
  }
}
