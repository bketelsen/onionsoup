import {
  RiAiAgentLine, RiBook2Line, RiBrainLine, RiFileEditLine, RiFileSearchLine, RiFileTextLine, RiFolder6Line, RiGitBranchLine, RiGlobalLine,
  RiListCheck2, RiListCheck3, RiMenuSearchLine, RiPencilLine, RiQuestionAnswerLine, RiScan2Line, RiSurveyLine, RiTerminalBoxLine, RiToolsLine,
} from '@remixicon/react';
import type { Part } from '../types.ts';

// Tool icons, titles and one-line descriptions, following OpenChamber's toolPresentation.tsx and toolHelpers.ts
// (MIT, see ../../NOTICE). onionsoup's own tools get their own names.

type Icon = typeof RiToolsLine;

const ICONS: [RegExp, Icon][] = [
  [/^(edit|multiedit|apply_patch|str_replace|str_replace_based_edit_tool)$/, RiPencilLine],
  [/^(write|create|file_write)$/, RiFileEditLine],
  [/^(read|view|file_read|cat)$/, RiFileTextLine],
  [/^(bash|shell|cmd|terminal)$/, RiTerminalBoxLine],
  [/^(list|ls|dir|list_files)$/, RiFolder6Line],
  [/^(search|grep|find|ripgrep)$/, RiMenuSearchLine],
  [/^glob$/, RiFileSearchLine],
  [/^(fetch|curl|wget|webfetch|web-search|websearch|search_web|codesearch)$/, RiGlobalLine],
  [/^(todowrite|todoread)$/, RiListCheck3],
  [/^structuredoutput$/i, RiListCheck2],
  [/^skill$/, RiBook2Line],
  [/^task$/, RiAiAgentLine],
  [/^question$/, RiSurveyLine],
  [/^lsp$/, RiScan2Line],
  [/^git/, RiGitBranchLine],
  [/^onionsoup_ask$/, RiQuestionAnswerLine],
  [/^onionsoup_/, RiBrainLine],
];

export function ToolIcon({ tool, className = 'h-3.5 w-3.5 flex-shrink-0' }: { tool: string; className?: string }) {
  const Icon = ICONS.find(([pattern]) => pattern.test(tool))?.[1] ?? RiToolsLine;
  return <Icon className={className} />;
}

const TITLES: Record<string, string> = {
  read: 'Read File', write: 'Write File', edit: 'Edit File', multiedit: 'Multi-Edit', apply_patch: 'Apply Patch', bash: 'Shell Command',
  grep: 'Search Files', glob: 'Find Files', list: 'List Directory', task: 'Agent Task', webfetch: 'Fetch URL', websearch: 'Web Search',
  codesearch: 'Code Search', todowrite: 'Update Todo List', todoread: 'Read Todo List', skill: 'Load Skill', question: 'Question', lsp: 'LSP',
  onionsoup_status: 'Status', onionsoup_notebook: 'Notebook', onionsoup_evidence: 'Evidence', onionsoup_ask: 'Ask Owner',
  onionsoup_checkout_pr: 'Check Out PR', onionsoup_propose_changes: 'Propose Changes', onionsoup_ship: 'Ship', onionsoup_request_publish: 'Request Publish',
  onionsoup_record_decision: 'Record Decision', onionsoup_record_fact: 'Record Fact', onionsoup_submit_plan: 'Submit Plan', onionsoup_retract: 'Retract', onionsoup_owners: 'Manage Owners',
};

export function toolTitle(tool: string) {
  if (TITLES[tool]) return TITLES[tool];
  const spaced = tool.replace(/[_-]+/g, ' ').trim();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

export const STATIC_TOOLS = new Set(['read', 'skill']);

function truncate(text: string, length: number) {
  return text.length > length ? `${text.slice(0, length - 1)}…` : text;
}

function relativePath(path: string, directory: string) {
  return directory && path.startsWith(`${directory}/`) ? path.slice(directory.length + 1) : path;
}

interface ToolInput { text: (key: string) => string; path: string; directory: string; input: Record<string, unknown> }

function filePath({ path, directory }: ToolInput) {
  return path ? relativePath(path, directory) : '';
}

function searchPattern({ text, path, directory }: ToolInput) {
  return `"${truncate(text('pattern'), 40)}"${path ? ` in ${relativePath(path, directory)}` : ''}`;
}

const titleOf = ({ text }: ToolInput) => text('title');

/** How each tool describes one call; any other tool shows its description or title. */
const DESCRIPTIONS: Record<string, (call: ToolInput) => string> = {
  bash: ({ text }) => truncate(text('command').split('\n')[0] ?? '', 100),
  edit: filePath, multiedit: filePath, read: filePath, write: filePath, lsp: filePath,
  task: ({ text }) => truncate(text('description'), 80),
  question: ({ input }) => `Asked ${(input.questions as unknown[] | undefined)?.length ?? 1} question(s)`,
  grep: searchPattern, glob: searchPattern,
  webfetch: ({ text }) => text('url'),
  websearch: ({ text }) => truncate(text('query'), 50),
  skill: ({ text }) => text('name'),
  onionsoup_ask: ({ text }) => `${text('owner')}: ${truncate(text('question'), 80)}`,
  onionsoup_propose_changes: titleOf, onionsoup_submit_plan: titleOf,
  onionsoup_checkout_pr: ({ text }) => text('item'),
  onionsoup_owners: ({ text }) => [text('action'), text('id')].filter(Boolean).join(' '),
};

/** The one-line description beside a tool's title. */
export function toolDescription(part: Part, directory: string) {
  const input = (part.state?.input ?? {}) as Record<string, unknown>;
  const text = (key: string) => (typeof input[key] === 'string' ? (input[key] as string) : '');
  const call = { text, input, directory, path: text('filePath') || text('path') || text('file_path') };
  const described = DESCRIPTIONS[part.tool ?? '']?.(call);
  return described || text('description') || (part.state?.metadata?.description as string | undefined) || part.state?.title || '';
}

export function formatDuration(milliseconds: number) {
  if (milliseconds < 1000) return `${milliseconds}ms`;
  const seconds = milliseconds / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  return `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s`;
}
