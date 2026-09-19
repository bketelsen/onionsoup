import ts from 'typescript';
import { readFile, readdir } from 'node:fs/promises';
import { resolve, relative, dirname, join } from 'node:path';
const workspaces = new Map();
for (const group of ['packages', 'apps']) for (const name of await readdir(group)) {
  const directory = resolve(group, name), manifest = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'));
  workspaces.set(manifest.name, { directory, manifest, group });
}
async function sources(directory) {
  return (await Promise.all((await readdir(directory, { withFileTypes: true })).map(async entry =>
    entry.isDirectory() ? sources(join(directory, entry.name)) : entry.name.endsWith('.ts') ? [join(directory, entry.name)] : []))).flat();
}
const edges = new Map();
for (const [name, workspace] of workspaces) {
  const deps = new Set(); edges.set(name, deps);
  if (!workspace.manifest.private || workspace.manifest.version !== '0.1.0') throw new Error(`${name}: private coordinated version required`);
  for (const file of await sources(join(workspace.directory, 'src'))) {
    const source = ts.createSourceFile(file, await readFile(file, 'utf8'), ts.ScriptTarget.Latest, true);
    function check(specifier) {
      if (specifier.startsWith('node:')) return;
      if (specifier.startsWith('.')) {
        const target = resolve(dirname(file), specifier);
        if (relative(join(workspace.directory, 'src'), target).startsWith('..')) throw new Error(`${file}: relative import escapes package: ${specifier}`);
        return;
      }
      const dep = specifier.startsWith('@') ? specifier.split('/').slice(0, 2).join('/') : specifier.split('/')[0];
      if (!workspace.manifest.dependencies?.[dep]) throw new Error(`${file}: undeclared dependency ${dep}`);
      if (dep.startsWith('@onionsoup/')) {
        const target = workspaces.get(dep), key = specifier === dep ? '.' : `.${specifier.slice(dep.length)}`;
        if (!target || target.group === 'apps' || !target.manifest.exports[key]) throw new Error(`${file}: dependency must be a public package export: ${specifier}`);
        deps.add(dep);
      }
    }
    function walk(node) {
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) check(node.moduleSpecifier.text);
      if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || node.expression.getText(source) === 'require')) {
        if (node.arguments.length !== 1 || !ts.isStringLiteral(node.arguments[0])) throw new Error(`${file}: computed imports bypass package boundaries`);
        check(node.arguments[0].text);
      }
      if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) && ts.isStringLiteral(node.argument.literal)) check(node.argument.literal.text);
      ts.forEachChild(node, walk);
    }
    walk(source);
  }
}
function visit(name, stack = []) {
  if (stack.includes(name)) throw new Error(`Workspace cycle: ${[...stack, name].join(' -> ')}`);
  for (const child of edges.get(name) ?? []) visit(child, [...stack, name]);
}
for (const name of edges.keys()) visit(name);
console.log(`Verified public dependency boundaries for ${workspaces.size} workspaces.`);
