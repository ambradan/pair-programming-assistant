import * as fs from "fs";
import * as path from "path";
import { glob } from "glob";

/**
 * Project Indexer
 *
 * Scans a project directory and builds an in-memory index of:
 * - All source files with their content
 * - Function/class/method declarations with line numbers
 * - Import/export relationships (dependency graph)
 *
 * This index is what allows the PPA to find "exactly where"
 * a modification needs to happen.
 */

export interface FileEntry {
  path: string;
  relativePath: string;
  content: string;
  lines: string[];
  language: string;
  symbols: SymbolEntry[];
}

export interface SymbolEntry {
  name: string;
  kind: "function" | "class" | "method" | "variable" | "interface" | "type" | "enum" | "route";
  line: number;
  endLine: number;
  parentClass?: string;
  exported: boolean;
  signature?: string;
}

export interface DependencyEdge {
  from: string; // file path
  to: string;   // file path
  imports: string[]; // symbol names
}

export interface ProjectIndex {
  rootDir: string;
  files: Map<string, FileEntry>;
  symbols: Map<string, SymbolEntry & { file: string }>;
  dependencies: DependencyEdge[];
  indexedAt: Date;
}

const LANGUAGE_MAP: Record<string, string> = {
  ".ts": "typescript",
  ".tsx": "typescript",
  ".js": "javascript",
  ".jsx": "javascript",
  ".py": "python",
  ".sql": "sql",
  ".prisma": "prisma",
  ".json": "json",
  ".yml": "yaml",
  ".yaml": "yaml",
  ".md": "markdown",
  ".env": "env",
};

const IGNORE_DIRS = [
  "node_modules", "dist", ".git", "coverage",
  ".next", "__pycache__", ".futurecode",
];

/**
 * Index a project directory.
 * Returns an in-memory searchable index of all source files.
 */
export async function indexProject(rootDir: string): Promise<ProjectIndex> {
  const absoluteRoot = path.resolve(rootDir);
  const files = new Map<string, FileEntry>();
  const allSymbols = new Map<string, SymbolEntry & { file: string }>();
  const dependencies: DependencyEdge[] = [];

  // Find all source files
  const patterns = ["**/*.ts", "**/*.js", "**/*.tsx", "**/*.jsx", "**/*.prisma", "**/*.sql", "**/*.py"];
  const ignorePatterns = IGNORE_DIRS.map((d) => `**/${d}/**`);

  const filePaths = await glob(patterns, {
    cwd: absoluteRoot,
    ignore: ignorePatterns,
    nodir: true,
  });

  for (const relPath of filePaths) {
    const absPath = path.join(absoluteRoot, relPath);
    const content = fs.readFileSync(absPath, "utf-8");
    const lines = content.split("\n");
    const ext = path.extname(relPath);
    const language = LANGUAGE_MAP[ext] ?? "unknown";

    const symbols = extractSymbols(content, lines, language);

    const entry: FileEntry = {
      path: absPath,
      relativePath: relPath,
      content,
      lines,
      language,
      symbols,
    };

    files.set(relPath, entry);

    // Register symbols globally
    for (const sym of symbols) {
      const key = sym.parentClass
        ? `${sym.parentClass}.${sym.name}`
        : sym.name;
      allSymbols.set(key, { ...sym, file: relPath });
    }

    // Extract dependencies (imports)
    if (language === "typescript" || language === "javascript") {
      const deps = extractImports(content, relPath, absoluteRoot);
      dependencies.push(...deps);
    }
  }

  return {
    rootDir: absoluteRoot,
    files,
    symbols: allSymbols,
    dependencies,
    indexedAt: new Date(),
  };
}

/**
 * Extract symbols (functions, classes, methods) from source code.
 * Uses regex-based extraction — fast and good enough for our use case.
 * ts-morph is available for deeper AST analysis if needed.
 */
function extractSymbols(
  content: string,
  lines: string[],
  language: string
): SymbolEntry[] {
  const symbols: SymbolEntry[] = [];

  if (language === "typescript" || language === "javascript") {
    extractTSSymbols(lines, symbols);
  } else if (language === "prisma") {
    extractPrismaSymbols(lines, symbols);
  }

  return symbols;
}

function extractTSSymbols(lines: string[], symbols: SymbolEntry[]): void {
  let currentClass: string | undefined;
  let braceDepth = 0;
  let classStartDepth = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    // Track brace depth for class scope
    braceDepth += (line.match(/\{/g) ?? []).length;
    braceDepth -= (line.match(/\}/g) ?? []).length;

    if (currentClass && braceDepth <= classStartDepth) {
      currentClass = undefined;
    }

    // Exported function
    const funcMatch = trimmed.match(
      /^(export\s+)?(async\s+)?function\s+(\w+)/
    );
    if (funcMatch) {
      symbols.push({
        name: funcMatch[3],
        kind: "function",
        line: i + 1,
        endLine: findBlockEnd(lines, i),
        exported: !!funcMatch[1],
        signature: trimmed.split("{")[0].trim(),
      });
    }

    // Arrow function (const name = ...)
    const arrowMatch = trimmed.match(
      /^(export\s+)?(const|let)\s+(\w+)\s*=\s*(async\s*)?\(/
    );
    if (arrowMatch) {
      symbols.push({
        name: arrowMatch[3],
        kind: "function",
        line: i + 1,
        endLine: findBlockEnd(lines, i),
        exported: !!arrowMatch[1],
        signature: trimmed.split("=>")[0].trim(),
      });
    }

    // Class declaration
    const classMatch = trimmed.match(
      /^(export\s+)?class\s+(\w+)/
    );
    if (classMatch) {
      currentClass = classMatch[2];
      classStartDepth = braceDepth - 1;
      symbols.push({
        name: classMatch[2],
        kind: "class",
        line: i + 1,
        endLine: findBlockEnd(lines, i),
        exported: !!classMatch[1],
      });
    }

    // Method inside class
    if (currentClass) {
      const methodMatch = trimmed.match(
        /^(async\s+)?(\w+)\s*\(/
      );
      if (
        methodMatch &&
        !trimmed.startsWith("if") &&
        !trimmed.startsWith("for") &&
        !trimmed.startsWith("while") &&
        !trimmed.startsWith("switch") &&
        !trimmed.startsWith("//")
      ) {
        symbols.push({
          name: methodMatch[2],
          kind: "method",
          line: i + 1,
          endLine: findBlockEnd(lines, i),
          parentClass: currentClass,
          exported: false,
          signature: trimmed.split("{")[0].trim(),
        });
      }
    }

    // Interface
    const interfaceMatch = trimmed.match(
      /^(export\s+)?interface\s+(\w+)/
    );
    if (interfaceMatch) {
      symbols.push({
        name: interfaceMatch[2],
        kind: "interface",
        line: i + 1,
        endLine: findBlockEnd(lines, i),
        exported: !!interfaceMatch[1],
      });
    }

    // Type alias
    const typeMatch = trimmed.match(
      /^(export\s+)?type\s+(\w+)/
    );
    if (typeMatch) {
      symbols.push({
        name: typeMatch[2],
        kind: "type",
        line: i + 1,
        endLine: i + 1,
        exported: !!typeMatch[1],
      });
    }

    // Fastify route detection
    const routeMatch = trimmed.match(
      /\.(get|post|put|patch|delete)\s*[<(]/i
    );
    if (routeMatch) {
      const pathMatch = trimmed.match(/["'`](\/[^"'`]*)["'`]/);
      symbols.push({
        name: `${routeMatch[1].toUpperCase()} ${pathMatch?.[1] ?? "?"}`,
        kind: "route",
        line: i + 1,
        endLine: findBlockEnd(lines, i),
        exported: false,
        signature: trimmed,
      });
    }
  }
}

function extractPrismaSymbols(lines: string[], symbols: SymbolEntry[]): void {
  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(/^model\s+(\w+)/);
    if (match) {
      symbols.push({
        name: match[1],
        kind: "class",
        line: i + 1,
        endLine: findBlockEnd(lines, i),
        exported: true,
      });
    }
  }
}

function findBlockEnd(lines: string[], startLine: number): number {
  let depth = 0;
  let started = false;
  for (let i = startLine; i < lines.length; i++) {
    for (const ch of lines[i]) {
      if (ch === "{") {
        depth++;
        started = true;
      }
      if (ch === "}") depth--;
      if (started && depth === 0) return i + 1;
    }
  }
  return startLine + 1;
}

/**
 * Extract import dependencies from TypeScript/JavaScript.
 */
function extractImports(
  content: string,
  filePath: string,
  rootDir: string
): DependencyEdge[] {
  const edges: DependencyEdge[] = [];
  const importRegex = /import\s+(?:{([^}]+)}|\*\s+as\s+(\w+)|(\w+))\s+from\s+["']([^"']+)["']/g;

  let match;
  while ((match = importRegex.exec(content)) !== null) {
    const importPath = match[4];

    // Only track local imports
    if (!importPath.startsWith(".") && !importPath.startsWith("/")) continue;

    const symbols = match[1]
      ? match[1].split(",").map((s) => s.trim().split(" as ")[0].trim())
      : match[2]
        ? [match[2]]
        : match[3]
          ? [match[3]]
          : [];

    // Resolve relative path
    const dir = path.dirname(filePath);
    let resolved = path.join(dir, importPath);
    // Try common extensions
    for (const ext of [".ts", ".js", ".tsx", ".jsx", "/index.ts", "/index.js"]) {
      if (resolved.endsWith(ext)) break;
      const candidate = resolved + ext;
      if (fs.existsSync(path.join(rootDir, candidate))) {
        resolved = candidate;
        break;
      }
    }

    edges.push({
      from: filePath,
      to: resolved,
      imports: symbols,
    });
  }

  return edges;
}

/**
 * Search the index for a symbol or concept.
 * Returns matching files and symbols ranked by relevance.
 */
export function searchIndex(
  index: ProjectIndex,
  query: string
): Array<{
  file: string;
  symbol?: SymbolEntry;
  relevance: number;
  matchType: "exact_symbol" | "partial_symbol" | "content" | "filename";
}> {
  const results: Array<{
    file: string;
    symbol?: SymbolEntry;
    relevance: number;
    matchType: "exact_symbol" | "partial_symbol" | "content" | "filename";
  }> = [];

  const queryLower = query.toLowerCase();
  const queryWords = queryLower.split(/\s+/);

  // Search symbols
  for (const [key, sym] of index.symbols) {
    const nameLower = key.toLowerCase();
    if (nameLower === queryLower) {
      results.push({
        file: sym.file,
        symbol: sym,
        relevance: 1.0,
        matchType: "exact_symbol",
      });
    } else if (nameLower.includes(queryLower) || queryLower.includes(nameLower)) {
      results.push({
        file: sym.file,
        symbol: sym,
        relevance: 0.7,
        matchType: "partial_symbol",
      });
    } else if (queryWords.some((w) => nameLower.includes(w))) {
      results.push({
        file: sym.file,
        symbol: sym,
        relevance: 0.4,
        matchType: "partial_symbol",
      });
    }
  }

  // Search file names
  for (const [relPath] of index.files) {
    const fileNameLower = relPath.toLowerCase();
    if (queryWords.some((w) => fileNameLower.includes(w))) {
      results.push({
        file: relPath,
        relevance: 0.5,
        matchType: "filename",
      });
    }
  }

  // Search content (expensive, do last, limit)
  if (results.length < 3) {
    for (const [relPath, entry] of index.files) {
      if (results.some((r) => r.file === relPath)) continue;
      const contentLower = entry.content.toLowerCase();
      if (contentLower.includes(queryLower)) {
        // Find the line
        const lineIdx = entry.lines.findIndex((l) =>
          l.toLowerCase().includes(queryLower)
        );
        results.push({
          file: relPath,
          relevance: 0.3,
          matchType: "content",
        });
      }
    }
  }

  // Sort by relevance
  results.sort((a, b) => b.relevance - a.relevance);
  return results.slice(0, 10);
}

/**
 * Find all files that depend on (import from) a given file.
 * Used for "what else do I need to change" navigation.
 */
export function findDependents(
  index: ProjectIndex,
  filePath: string
): string[] {
  return index.dependencies
    .filter((dep) => dep.to.includes(filePath))
    .map((dep) => dep.from);
}

/**
 * Find all files that a given file imports from.
 */
export function findDependencies(
  index: ProjectIndex,
  filePath: string
): string[] {
  return index.dependencies
    .filter((dep) => dep.from === filePath)
    .map((dep) => dep.to);
}
