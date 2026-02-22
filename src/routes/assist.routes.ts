import { FastifyInstance } from "fastify";
import { AssistService, AssistRequest } from "../services/assist.service.js";
import { LLMProvider } from "../llm/provider.js";
import {
  indexProject,
  ProjectIndex,
  searchIndex,
} from "../indexer/project-indexer.js";
import {
  generateProjectMap,
  ProjectMap,
  watchProjectFiles,
  serializeMapForLLM,
} from "../indexer/project-map.js";

// Cache per project path
const indexCache = new Map<string, ProjectIndex>();
const mapCache = new Map<string, ProjectMap>();
const watcherCleanups = new Map<string, () => void>();

async function getOrCreateIndex(projectPath: string): Promise<{
  index: ProjectIndex;
  map: ProjectMap;
}> {
  const existing = indexCache.get(projectPath);
  const existingMap = mapCache.get(projectPath);

  // Re-index if older than 5 minutes
  if (
    existing &&
    existingMap &&
    Date.now() - existing.indexedAt.getTime() < 5 * 60 * 1000
  ) {
    return { index: existing, map: existingMap };
  }

  // Full re-index
  const index = await indexProject(projectPath);
  indexCache.set(projectPath, index);

  // Generate project map
  const map = generateProjectMap(index);
  mapCache.set(projectPath, map);

  // Start file watching (cleanup old watcher first)
  const oldCleanup = watcherCleanups.get(projectPath);
  if (oldCleanup) oldCleanup();

  const cleanup = watchProjectFiles(projectPath, index, map, (changedFiles) => {
    console.log(`[Routes] Files changed: ${changedFiles.join(", ")}`);
  });
  watcherCleanups.set(projectPath, cleanup);

  console.log(
    `[Routes] Indexed ${index.files.size} files, ` +
    `${index.symbols.size} symbols, ` +
    `map ~${map.totalTokenEstimate} tokens`
  );

  return { index, map };
}

export async function assistRoutes(fastify: FastifyInstance) {
  const llm = new LLMProvider({
    anthropicApiKey: process.env.ANTHROPIC_API_KEY,
    nebiusApiKey:    process.env.NEBIUS_API_KEY,
    geminiApiKey:    process.env.GEMINI_API_KEY,
  });

  /**
   * POST /assist
   * Main endpoint: natural language → code changes.
   */
  fastify.post<{
    Body: AssistRequest;
  }>("/assist", async (request, reply) => {
    const { message, projectPath, forceModel } = request.body;

    if (!message || !projectPath) {
      return reply.status(400).send({
        error: "ValidationError",
        message: "message and projectPath are required",
      });
    }

    try {
      const { index, map } = await getOrCreateIndex(projectPath);
      const service = new AssistService(llm, index, map);
      const result = await service.assist({ message, projectPath, forceModel });
      return { data: result };
    } catch (error: any) {
      fastify.log.error(error, "Assist failed");
      return reply.status(500).send({
        error: "AssistError",
        message: error.message,
      });
    }
  });

  /**
   * POST /index
   * Force re-index a project.
   */
  fastify.post<{
    Body: { projectPath: string };
  }>("/index", async (request, reply) => {
    const { projectPath } = request.body;

    if (!projectPath) {
      return reply.status(400).send({
        error: "ValidationError",
        message: "projectPath is required",
      });
    }

    try {
      // Force fresh index
      indexCache.delete(projectPath);
      mapCache.delete(projectPath);

      const { index, map } = await getOrCreateIndex(projectPath);

      return {
        data: {
          rootDir: index.rootDir,
          filesIndexed: index.files.size,
          symbolsFound: index.symbols.size,
          dependencyEdges: index.dependencies.length,
          mapTokenEstimate: map.totalTokenEstimate,
          indexedAt: index.indexedAt,
        },
      };
    } catch (error: any) {
      return reply.status(500).send({
        error: "IndexError",
        message: error.message,
      });
    }
  });

  /**
   * POST /search
   * Search the indexed project for symbols/content.
   */
  fastify.post<{
    Body: { projectPath: string; query: string };
  }>("/search", async (request, reply) => {
    const { projectPath, query } = request.body;

    if (!projectPath || !query) {
      return reply.status(400).send({
        error: "ValidationError",
        message: "projectPath and query are required",
      });
    }

    const { index } = await getOrCreateIndex(projectPath);
    const results = searchIndex(index, query);

    return { data: results };
  });

  /**
   * GET /map
   * View the current project map (for debugging).
   */
  fastify.post<{
    Body: { projectPath: string };
  }>("/map", async (request, reply) => {
    const { projectPath } = request.body;
    const map = mapCache.get(projectPath);

    if (!map) {
      return reply.status(404).send({
        error: "NotIndexed",
        message: "Project not indexed yet. POST /index first.",
      });
    }

    return {
      data: {
        serialized: serializeMapForLLM(map),
        fileCount: map.files.size,
        tokenEstimate: map.totalTokenEstimate,
        generatedAt: map.generatedAt,
      },
    };
  });

  /**
   * GET /status
   */
  fastify.get("/status", async () => {
    const projects = Array.from(indexCache.entries()).map(([p, index]) => {
      const map = mapCache.get(p);
      return {
        path: p,
        files: index.files.size,
        symbols: index.symbols.size,
        mapTokens: map?.totalTokenEstimate ?? 0,
        indexedAt: index.indexedAt,
        watching: watcherCleanups.has(p),
      };
    });

    return {
      status: "ok",
      timestamp: new Date().toISOString(),
      providers: llm.backends,
      indexedProjects: projects,
    };
  });

  /**
   * POST /apply
   * Apply a code change to disk.
   * Creates a .bak backup before overwriting.
   */
  fastify.post<{
    Body: {
      projectPath: string;
      changes: Array<{
        file: string;
        startLine: number;
        endLine: number;
        originalCode: string;
        proposedCode: string;
      }>;
    };
  }>("/apply", async (request, reply) => {
    const { projectPath, changes } = request.body;

    if (!projectPath || !changes?.length) {
      return reply.status(400).send({
        error: "ValidationError",
        message: "projectPath and changes are required",
      });
    }

    const fs = await import("fs");
    const path = await import("path");
    const results: Array<{ file: string; status: string; backup?: string }> = [];

    for (const change of changes) {
      const absPath = path.join(projectPath, change.file);

      try {
        // Check file exists
        if (!fs.existsSync(absPath)) {
          results.push({ file: change.file, status: "error: file not found" });
          continue;
        }

        // Read current content
        const content = fs.readFileSync(absPath, "utf-8");
        const lines = content.split("\n");

        // Create backup
        const backupPath = absPath + ".bak";
        fs.writeFileSync(backupPath, content, "utf-8");

        // Replace lines (startLine and endLine are 1-indexed)
        const before = lines.slice(0, change.startLine - 1);
        const after = lines.slice(change.endLine);
        const proposedLines = change.proposedCode.split("\n");

        const newContent = [...before, ...proposedLines, ...after].join("\n");
        fs.writeFileSync(absPath, newContent, "utf-8");

        results.push({
          file: change.file,
          status: "applied",
          backup: change.file + ".bak",
        });

        console.log(`[Apply] ✅ ${change.file} (backup: ${change.file}.bak)`);
      } catch (err: any) {
        results.push({ file: change.file, status: `error: ${err.message}` });
        console.error(`[Apply] ❌ ${change.file}: ${err.message}`);
      }
    }

    // Invalidate index cache so next assist sees updated code
    indexCache.delete(projectPath);
    mapCache.delete(projectPath);

    return { data: { results } };
  });

  /**
   * POST /revert
   * Revert a file from its .bak backup.
   */
  fastify.post<{
    Body: { projectPath: string; file: string };
  }>("/revert", async (request, reply) => {
    const { projectPath, file } = request.body;
    const fs = await import("fs");
    const path = await import("path");

    const absPath = path.join(projectPath, file);
    const backupPath = absPath + ".bak";

    if (!fs.existsSync(backupPath)) {
      return reply.status(404).send({
        error: "NoBackup",
        message: `No backup found for ${file}`,
      });
    }

    const backup = fs.readFileSync(backupPath, "utf-8");
    fs.writeFileSync(absPath, backup, "utf-8");
    fs.unlinkSync(backupPath);

    // Invalidate cache
    indexCache.delete(projectPath);
    mapCache.delete(projectPath);

    console.log(`[Revert] ↩️ ${file} restored from backup`);
    return { data: { file, status: "reverted" } };
  });

/**
   * POST /clone
   * Clone a git repository to a local temp directory.
   */
  fastify.post<{
    Body: { gitUrl: string };
  }>("/clone", async (request, reply) => {
    const { gitUrl } = request.body;
    if (!gitUrl) {
      return reply.status(400).send({
        error: "ValidationError",
        message: "gitUrl is required",
      });
    }
    try {
      const { cloneRepository } = await import("../services/git-clone.service.js");
      const result = cloneRepository(gitUrl);
      return {
        data: {
          localPath: result.localPath,
          cached: result.cached,
          gitUrl,
        },
      };
    } catch (error: any) {
      fastify.log.error(error, "Clone failed");
      return reply.status(500).send({
        error: "CloneError",
        message: error.message,
      });
    }
  });

  // Cleanup watchers on server shutdown
  fastify.addHook("onClose", async () => {
    for (const cleanup of watcherCleanups.values()) {
      cleanup();
    }
  });
}
