// Lexical navigation only: these hints neither establish scope/coverage nor create excerpts.
// Operates on an already admitted, size-bounded pinned blob; never executes/parses project code.
export function testNavigation(lines: string[], startLine: number, endLine: number) {
  const testStart = /^\s*(?:(?:it|test)(?:\.[A-Za-z]+)*\s*\(|(?:async\s+)?def\s+test_)/;
  const assertion = /^\s*(?:(?:await\s+|return\s+)?(?:expect|assert)\s*[.(]|assert\s+\S)/;
  const preview = (index: number) => ({ line: index + 1, preview: lines[index].trim().slice(0, 180) });
  const assertionAfter = (index: number) => {
    for (let i = index; i < Math.min(lines.length, index + 120); i++) {
      if (testStart.test(lines[i])) break;
      if (assertion.test(lines[i])) return i + 1;
    }
    return null;
  };
  const symbols = new Set<string>();
  for (const line of lines.slice(startLine - 1, endLine)) {
    const declaration = /^\s*(?:export\s+)?(?:async\s+)?function\s+([\w$]+)\s*\(|^\s*(?:async\s+)?def\s+([\w]+)\s*\(/.exec(line);
    if (declaration) symbols.add(declaration[1] ?? declaration[2]);
  }
  const references: Array<{ symbol: string; line: number; preview: string;
    precedingTest: { line: number; preview: string } | null; followingAssertionLine: number | null }> = [];
  let referencesTruncated = symbols.size > 2;
  for (const symbol of [...symbols].slice(0, 2)) {
    const call = new RegExp(`(?:^|[^\\w$])${symbol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\(`);
    let found = 0, preceding = -1;
    for (let i = 0; i < lines.length; i++) {
      if (testStart.test(lines[i])) preceding = i;
      if (i + 1 >= startLine && i + 1 <= endLine || /^\s*(?:\/\/|#|\*)/.test(lines[i]) || !call.test(lines[i])) continue;
      if (found++ >= 2) { referencesTruncated = true; continue; }
      references.push({ symbol, ...preview(i), precedingTest: preceding < 0 ? null : preview(preceding),
        followingAssertionLine: assertionAfter(i) });
    }
  }
  return { fixtureReferences: references, referencesTruncated,
    nextAssertionLine: assertionAfter(endLine),
    note: 'Lexical hints from this pinned test file only, not read evidence or verified scope/coverage. Read a fixture reference with its test setup and assertion before citing. A following assertion may concern another behavior; assess relevance to the report. Missing hints do not mean missing tests.' };
}
