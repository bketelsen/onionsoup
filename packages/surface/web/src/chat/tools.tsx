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
  onionsoup_open_work: 'Open Work', onionsoup_propose_changes: 'Propose Changes', onionsoup_ship: 'Ship', onionsoup_request_publish: 'Request Publish',
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

/** The one-line description beside a tool's title. */
export function toolDescription(part: Part, directory: string) {
  const tool = part.tool ?? '';
  const input = (part.state?.input ?? {}) as Record<string, unknown>;
  const string = (key: string) => (typeof input[key] === 'string' ? (input[key] as string) : '');
  const path = string('filePath') || string('path') || string('file_path');
  if (tool === 'bash') return truncate((string('command').split('\n')[0] ?? ''), 100);
  if (['edit', 'multiedit', 'read', 'write', 'lsp'].includes(tool) && path) return relativePath(path, directory);
  if (tool === 'task') return truncate(string('description'), 80);
  if (tool === 'question') return `Asked ${(input.questions as unknown[] | undefined)?.length ?? 1} question(s)`;
  if (tool === 'grep' || tool === 'glob') return `"${truncate(string('pattern'), 40)}"${path ? ` in ${relativePath(path, directory)}` : ''}`;
  if (tool === 'webfetch') return string('url');
  if (tool === 'websearch') return truncate(string('query'), 50);
  if (tool === 'skill') return string('name');
  if (tool === 'onionsoup_ask') return `${string('owner')}: ${truncate(string('question'), 80)}`;
  if (tool === 'onionsoup_open_work' || tool === 'onionsoup_propose_changes') return string('title');
  if (tool === 'onionsoup_owners') return [string('action'), string('id')].filter(Boolean).join(' ');
  return string('description') || (part.state?.metadata?.description as string | undefined) || part.state?.title || '';
}

export function formatDuration(milliseconds: number) {
  if (milliseconds < 1000) return `${milliseconds}ms`;
  const seconds = milliseconds / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  return `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s`;
}
