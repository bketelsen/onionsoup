import { lstat, readFile, readdir, readlink, realpath, stat } from "node:fs/promises";
import path from "node:path";

// Deliberately local: ignored run artifacts and external URLs are not required.
const root = process.cwd();
const problems = [];
const complain = (file, message) => problems.push(`${file}: ${message}`);
const relative = (file) => path.relative(root, file).split(path.sep).join("/");
const aliases = {
  "CLAUDE.md": "AGENTS.md",
  "GEMINI.md": "AGENTS.md",
  ".github/copilot-instructions.md": "../AGENTS.md",
  ".claude/skills": "../.agents/skills",
  skills: ".agents/skills",
};

for (const [file, target] of Object.entries(aliases)) {
  try {
    if (!(await lstat(file)).isSymbolicLink() || (await readlink(file)) !== target) {
      complain(file, `must be a symlink to ${target}`);
    }
    await realpath(file);
  } catch {
    complain(file, `missing or broken symlink; expected ${target}`);
  }
}
for (const [file, kind] of [["AGENTS.md", "file"], [".agents/skills", "directory"]]) {
  try {
    const entry = await lstat(file);
    if (kind === "file" ? !entry.isFile() : !entry.isDirectory()) {
      complain(file, `must be a real ${kind}`);
    }
  } catch {
    complain(file, `missing canonical ${kind}`);
  }
}

async function markdownFiles(directory) {
  const files = [];
  try {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) files.push(...await markdownFiles(file));
      else if (entry.isFile() && entry.name.endsWith(".md")) files.push(file);
    }
  } catch {
    complain(directory, "cannot read directory");
  }
  return files.sort();
}

function prose(source) {
  let fence;
  return source.replace(/<!--[^]*?-->/g, "").split("\n").map((line) => {
    const match = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (match) {
      if (!fence) fence = match[1];
      else if (match[1][0] === fence[0] && match[1].length >= fence.length
        && line.slice(match[0].length).trim() === "") fence = undefined;
      return "";
    }
    return fence ? "" : line;
  }).join("\n");
}

// This repository uses inline links and ATX headings; templates may be unfinished.
function links(source) {
  const withoutInlineCode = prose(source).replace(/(`+)[^]*?\1/g, "");
  return [...withoutInlineCode.matchAll(/!?\[[^\]\n]*\]\(\s*(?:<([^>\n]+)>|([^\s)]+))(?:\s+"[^"\n]*")?\s*\)/g)]
    .map((match) => match[1] ?? match[2]);
}
function anchors(source) {
  const found = new Set([...prose(source).matchAll(/<a\s+id="([^"]+)"\s*><\/a>/g)].map(match => match[1]));
  for (const line of prose(source).split("\n")) {
    const heading = /^ {0,3}#{1,6}\s+(.+?)\s*#*\s*$/.exec(line);
    if (!heading) continue;
    const base = heading[1].replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
      .replace(/<[^>]*>/g, "").toLowerCase()
      .replace(/[^\p{L}\p{N}\p{M}_\-\s]/gu, "").replace(/\s/g, "-");
    let slug = base;
    let suffix = 0;
    while (found.has(slug)) slug = `${base}-${++suffix}`;
    found.add(slug);
  }
  return found;
}
function localTarget(file, href) {
  if (/^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(href)) return;
  const hash = href.indexOf("#");
  const target = hash < 0 ? href : href.slice(0, hash);
  const fragment = hash < 0 ? "" : href.slice(hash + 1);
  return {
    file: target ? path.resolve(path.dirname(file), decodeURIComponent(target.split("?")[0])) : path.resolve(file),
    fragment: decodeURIComponent(fragment),
  };
}

const docs = await markdownFiles("docs");
const skills = await markdownFiles(".agents/skills");
const files = ["AGENTS.md", "README.md", "REFERENCES.md", ...docs, ...skills];
const sources = new Map();
for (const file of files) {
  try { sources.set(path.resolve(file), await readFile(file, "utf8")); }
  catch { complain(file, "cannot read Markdown file"); }
}
for (const [file, source] of sources) {
  if (path.basename(file) === "TEMPLATE.md" || relative(file).includes("/TEMPLATE/")) continue;
  for (const href of links(source)) {
    try {
      const target = localTarget(file, href);
      if (!target) continue;
      const targetRelative = relative(target.file);
      if (targetRelative === ".." || targetRelative.startsWith("../") || path.isAbsolute(targetRelative)) {
        complain(relative(file), `link leaves repository: ${href}`);
        continue;
      }
      if (targetRelative.startsWith("runs/")) continue;
      await stat(target.file);
      if (target.fragment && target.file.endsWith(".md")) {
        const content = sources.get(target.file) ?? await readFile(target.file, "utf8");
        if (!anchors(content).has(target.fragment)) complain(relative(file), `missing heading: ${href}`);
      }
    } catch {
      complain(relative(file), `missing or invalid local link: ${href}`);
    }
  }
}
if (problems.length) {
  console.error(problems.join("\n"));
  process.exitCode = 1;
} else {
  console.log(`Documentation checks passed: ${docs.length} docs, ${skills.length} skill documents, ${Object.keys(aliases).length} symlinks.`);
}
