import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import {
  ProjectIndex,
  FileEntry,
  SymbolEntry,
  indexProject,
} from "./project-indexer.js";

/**
 * ProjectMap — Pre-computed compressed representation of the codebase.
 *
 * Instead of sending raw code to the LLM, we send a map:
 * "booking.service.ts → BookingService class: creates atomic bookings
 *  with FOR UPDATE locking. Methods: createBooking, cancelBooking, getBooking"
 *
 * This compresses ~500 lines of code into ~3 lines of context.
 * The LLM reads the map to understand the codebase structure,
 * then only needs the specific code section it's modifying.
 *
 * REACTIVE: file hashes track changes. When a file changes,
 * only that file's summary gets regenerated.
 */

export interface FileSummary {
  relativePath: string;
  language: string;
  hash: string; // md5 of content — used to detect changes
  lineCount: number;
  summary: string; // one-line description
  symbols: SymbolSummary[];
  imports: string[];
  exports: string[];
}

export interface SymbolSummary {
  name: string;
  kind: string;
  line: number;
  signature?: string;
  description: string; // one-line: what does this do
}

export interface ProjectMap {
  rootDir: string;
  files: Map<string, FileSummary>;
  generatedAt: Date;
  totalTokenEstimate: number;
}

/**
 * Generate a compressed map from a ProjectIndex.
 * This is the "pre-computing" step — runs once at index time.
 */
export function generateProjectMap(index: ProjectIndex): ProjectMap {
  const files = new Map<string, FileSummary>();
  let totalTokens = 0;

  for (const [relPath, entry] of index.files) {
    const summary = generateFileSummary(relPath, entry);
    files.set(relPath, summary);
    // Rough token estimate: 1 token per 4 chars
    totalTokens += summary.summary.length / 4;
    for (const sym of summary.symbols) {
      totalTokens += sym.description.length / 4;
    }
  }

  return {
    rootDir: index.rootDir,
    files,
    generatedAt: new Date(),
    totalTokenEstimate: Math.ceil(totalTokens),
  };
}

/**
 * Generate summary for a single file.
 * Uses heuristics to describe what the file does without an LLM.
 */
function generateFileSummary(relPath: string, entry: FileEntry): FileSummary {
  const hash = crypto
    .createHash("md5")
    .update(entry.content)
    .digest("hex");

  // Extract imports and exports
  const imports: string[] = [];
  const exports: string[] = [];

  for (const line of entry.lines) {
    const trimmed = line.trim();
    const importMatch = trimmed.match(/^import\s+.*from\s+["']([^"']+)["']/);
    if (importMatch) imports.push(importMatch[1]);
    if (trimmed.startsWith("export ")) {
      const exportName = trimmed.match(/export\s+(?:default\s+)?(?:class|function|const|interface|type|enum)\s+(\w+)/);
      if (exportName) exports.push(exportName[1]);
    }
  }

  // Generate symbol summaries
  const symbolSummaries = entry.symbols.map((sym) =>
    generateSymbolSummary(sym, entry)
  );

  // Generate file-level summary
  const summary = generateFileDescription(relPath, entry, symbolSummaries);

  return {
    relativePath: relPath,
    language: entry.language,
    hash,
    lineCount: entry.lines.length,
    summary,
    symbols: symbolSummaries,
    imports,
    exports,
  };
}

/**
 * Generate a one-line description of a symbol based on its code.
 * No LLM needed — pattern matching on common code patterns.
 */
function generateSymbolSummary(
  sym: SymbolEntry,
  entry: FileEntry
): SymbolSummary {
  const codeSlice = entry.lines
    .slice(sym.line - 1, Math.min(sym.endLine, sym.line + 5))
    .join(" ")
    .trim();

  let description = "";

  // Detect patterns
  if (sym.kind === "route") {
    description = `Route handler: ${sym.name}`;
  } else if (sym.kind === "class") {
    const methodCount = entry.symbols.filter(
      (s) => s.parentClass === sym.name && s.kind === "method"
    ).length;
    description = `Class with ${methodCount} methods`;

    // Check for common patterns
    if (codeSlice.includes("$transaction")) description += ", uses DB transactions";
    if (codeSlice.includes("FOR UPDATE")) description += ", row-level locking";
    if (codeSlice.includes("async")) description += ", async operations";
  } else if (sym.kind === "function") {
    // Infer purpose from name and body
    if (sym.name.includes("create") || sym.name.includes("Create"))
      description = "Creates a new record";
    else if (sym.name.includes("delete") || sym.name.includes("Delete") || sym.name.includes("cancel"))
      description = "Deletes/cancels a record";
    else if (sym.name.includes("get") || sym.name.includes("Get") || sym.name.includes("find"))
      description = "Retrieves data";
    else if (sym.name.includes("list") || sym.name.includes("List"))
      description = "Lists records with filtering";
    else if (sym.name.includes("validate") || sym.name.includes("check"))
      description = "Validates input";
    else if (sym.name.includes("notify") || sym.name.includes("send"))
      description = "Sends notification/message";
    else description = `Function: ${sym.name}`;

    // Enrich with code patterns
    if (codeSlice.includes("$transaction")) description += ", transactional";
    if (codeSlice.includes("FOR UPDATE")) description += ", with row locking";
    if (codeSlice.includes("throw new")) description += ", throws on error";
    if (codeSlice.includes("Promise.all")) description += ", parallel execution";
  } else if (sym.kind === "interface" || sym.kind === "type") {
    const fieldCount = codeSlice.split(";").length - 1;
    description = `Type definition with ~${Math.max(fieldCount, 1)} fields`;
  } else if (sym.kind === "method") {
    description = `Method of ${sym.parentClass ?? "unknown"}`;
    if (codeSlice.includes("$queryRaw") || codeSlice.includes("$executeRaw"))
      description += ", raw SQL";
    if (codeSlice.includes("FOR UPDATE")) description += ", row locking";
  } else {
    description = `${sym.kind}: ${sym.name}`;
  }

  return {
    name: sym.parentClass ? `${sym.parentClass}.${sym.name}` : sym.name,
    kind: sym.kind,
    line: sym.line,
    signature: sym.signature,
    description,
  };
}

/**
 * Generate a one-line file description.
 */
function generateFileDescription(
  relPath: string,
  entry: FileEntry,
  symbols: SymbolSummary[]
): string {
  const fileName = path.basename(relPath);

  // Pattern-based file description
  if (fileName.includes("route")) {
    const routes = symbols.filter((s) => s.kind === "route");
    return `Route definitions: ${routes.map((r) => r.name).join(", ") || "API endpoints"}`;
  }
  if (fileName.includes("service")) {
    const classes = symbols.filter((s) => s.kind === "class");
    const methods = symbols.filter((s) => s.kind === "method" || s.kind === "function");
    return `Business logic: ${classes.map((c) => c.name).join(", ") || methods.map((m) => m.name).join(", ")}`;
  }
  if (fileName.includes("schema")) {
    return `Validation schemas: ${symbols.map((s) => s.name).join(", ")}`;
  }
  if (fileName.includes("plugin")) {
    return `Fastify plugin: ${symbols.map((s) => s.name).join(", ")}`;
  }
  if (fileName.includes("test")) {
    return `Tests: ${symbols.length} test cases`;
  }
  if (fileName === "app.ts") {
    return "Application factory: assembles plugins and routes";
  }
  if (fileName === "server.ts") {
    return "Entry point: starts the HTTP server";
  }
  if (fileName.endsWith(".prisma")) {
    const models = symbols.filter((s) => s.kind === "class");
    return `Database schema: models ${models.map((m) => m.name).join(", ")}`;
  }

  return `${entry.language} file, ${entry.lines.length} lines, ${symbols.length} symbols`;
}

/**
 * Serialize the ProjectMap to a compact string for LLM context.
 * This is what actually goes into the prompt.
 */
export function serializeMapForLLM(map: ProjectMap): string {
  const parts: string[] = ["=== PROJECT MAP ==="];

  for (const [relPath, file] of map.files) {
    parts.push(`\n📄 ${relPath} (${file.lineCount}L) — ${file.summary}`);

    for (const sym of file.symbols) {
      const sig = sym.signature ? ` | ${sym.signature}` : "";
      parts.push(`  L${sym.line} ${sym.kind} ${sym.name}: ${sym.description}${sig}`);
    }

    if (file.imports.length > 0) {
      const localImports = file.imports.filter((i) => i.startsWith("."));
      if (localImports.length > 0) {
        parts.push(`  imports: ${localImports.join(", ")}`);
      }
    }
  }

  parts.push(`\n=== ${map.files.size} files, ~${map.totalTokenEstimate} tokens ===`);
  return parts.join("\n");
}

/**
 * Update a single file in the map (reactive update).
 * Called when a file changes on disk.
 */
export function updateFileInMap(
  map: ProjectMap,
  index: ProjectIndex,
  relPath: string
): boolean {
  const entry = index.files.get(relPath);
  if (!entry) {
    // File was deleted
    map.files.delete(relPath);
    return true;
  }

  const newHash = crypto
    .createHash("md5")
    .update(entry.content)
    .digest("hex");

  const existing = map.files.get(relPath);
  if (existing && existing.hash === newHash) {
    return false; // No change
  }

  // Regenerate just this file's summary
  const summary = generateFileSummary(relPath, entry);
  map.files.set(relPath, summary);
  map.generatedAt = new Date();

  return true;
}

/**
 * Watch project files and update map reactively.
 * Returns a cleanup function to stop watching.
 */
export function watchProjectFiles(
  projectRoot: string,
  index: ProjectIndex,
  map: ProjectMap,
  onUpdate?: (changedFiles: string[]) => void
): () => void {
  const watchers: fs.FSWatcher[] = [];
  const debounceTimers = new Map<string, NodeJS.Timeout>();

  for (const [relPath] of index.files) {
    const absPath = path.join(projectRoot, relPath);

    try {
      const watcher = fs.watch(absPath, (eventType) => {
        if (eventType !== "change") return;

        // Debounce: wait 500ms after last change
        const existing = debounceTimers.get(relPath);
        if (existing) clearTimeout(existing);

        debounceTimers.set(
          relPath,
          setTimeout(async () => {
            debounceTimers.delete(relPath);

            // Re-read the file
            try {
              const content = fs.readFileSync(absPath, "utf-8");
              const lines = content.split("\n");
              const entry = index.files.get(relPath);
              if (entry) {
                entry.content = content;
                entry.lines = lines;
                // Re-extract symbols would go here for full accuracy
                // For now, just update the map summary
                const changed = updateFileInMap(map, index, relPath);
                if (changed) {
                  console.log(`[ProjectMap] Updated: ${relPath}`);
                  onUpdate?.([relPath]);
                }
              }
            } catch {
              // File might have been deleted
              map.files.delete(relPath);
              console.log(`[ProjectMap] Removed: ${relPath}`);
              onUpdate?.([relPath]);
            }
          }, 500)
        );
      });

      watchers.push(watcher);
    } catch {
      // File might not exist yet, skip
    }
  }

  console.log(`[ProjectMap] Watching ${watchers.length} files for changes`);

  // Cleanup function
  return () => {
    for (const w of watchers) w.close();
    for (const t of debounceTimers.values()) clearTimeout(t);
    console.log("[ProjectMap] Stopped watching files");
  };
}
