import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { expect, it } from 'vitest';

const sourceRoot = fileURLToPath(new URL('../', import.meta.url));
function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const file = path.join(directory, entry.name);
    return entry.isDirectory() ? sourceFiles(file) : /\.tsx?$/.test(file) && !/\.(test|spec)\./.test(file) ? [file] : [];
  });
}

it('keeps product text free of demonstration branding without renaming internal storage or actions', () => {
  const matches: string[] = [];
  for (const file of sourceFiles(sourceRoot)) {
    const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true,
      file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
    function visit(node: ts.Node) {
      if (ts.isStringLiteralLike(node) || ts.isJsxText(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) {
        const text = node.text.trim();
        // Paths, storage identities, action discriminants, and test IDs are not
        // rendered prose. Retain them so saved local state stays compatible.
        const internal = /^[.@/]/.test(text) || /^sumore:/.test(text) ||
          /^(?:local|preview|demo|sample)-[\w:/-]+$/.test(text) ||
          ['preview', 'simulate', 'demo', 'sample'].includes(text);
        if (!internal && /\b(?:demo|preview|sample|simulat\w*|beta|prototype|placeholder)\b/i.test(text)) {
          const position = source.getLineAndCharacterOfPosition(node.getStart());
          matches.push(`${path.relative(sourceRoot, file)}:${position.line + 1}: ${text}`);
        }
      }
      ts.forEachChild(node, visit);
    }
    visit(source);
  }
  expect(matches).toEqual([]);
});
