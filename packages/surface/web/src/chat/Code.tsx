import { useEffect, useState } from 'react';

/** Code highlighted by shiki once it loads; plain text until then or for unknown languages. */
export function HighlightedCode({ code, language, className }: { code: string; language: string; className?: string }) {
  const [html, setHtml] = useState<string>();
  useEffect(() => {
    let live = true;
    void import('./highlight.ts').then(module => module.highlightLines(code, language)).then(lines => { if (live && lines) setHtml(lines.join('\n')); });
    return () => { live = false; };
  }, [code, language]);
  return html === undefined
    ? <pre className={className}>{code}</pre>
    : <pre className={className} dangerouslySetInnerHTML={{ __html: html }} />;
}
