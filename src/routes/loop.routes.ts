/**
 * Ralph loop HTTP routes — REST + SSE.
 *
 * Endpoints:
 *   POST /api/loop/decompose          Decompose a user prompt into a PRD checklist
 *   POST /api/loop/start              Start a loop session, return sessionId
 *   GET  /api/loop/events/:id         SSE stream of loop events (with replay buffer)
 *   GET  /api/loop/status/:id         Current session snapshot
 *   POST /api/loop/decide/:id         Human decision: accept | retry | skip | stop
 *   POST /api/loop/cancel/:id         Force-cancel a running session
 *   GET  /api/loop/sessions           List all active sessions
 */

import { FastifyInstance } from "fastify";
import { LLMProvider } from "../llm/provider.js";
import { AssistService } from "../services/assist.service.js";
import {
  indexProject,
  ProjectIndex,
  searchIndex,
} from "../indexer/project-indexer.js";
import {
  generateProjectMap,
  ProjectMap,
  serializeMapForLLM,
} from "../indexer/project-map.js";
import {
  decompose,
  runLoop,
  LoopConfig,
  LoopSession,
  LoopEvent,
  HumanDecision,
} from "../loop/runner.js";
import { parseTasks, getCompletionStatus, validatePrd } from "../loop/prd.js";

// ---------------------------------------------------------------------------
// Session registry
// ---------------------------------------------------------------------------

interface SessionEntry {
  session: LoopSession;
  // Buffered events for late-joining SSE clients (capped at 500)
  events: LoopEvent[];
  // Active SSE response objects
  subscribers: Set<import("http").ServerResponse>;
}

const sessions = new Map<string, SessionEntry>();

function cleanupSession(id: string): void {
  const entry = sessions.get(id);
  if (!entry) return;
  // Close any lingering SSE connections
  for (const res of entry.subscribers) {
    try { res.end(); } catch { /* ignore */ }
  }
  sessions.delete(id);
}

function broadcastEvent(entry: SessionEntry, event: LoopEvent): void {
  // Buffer for late joiners
  entry.events.push(event);
  if (entry.events.length > 500) entry.events.shift();

  // Push to all connected SSE clients
  const data = `data: ${JSON.stringify(event)}\n\n`;
  for (const res of entry.subscribers) {
    try { res.write(data); } catch { entry.subscribers.delete(res); }
  }
}

// ---------------------------------------------------------------------------
// Project index cache (shared with assist routes)
// ---------------------------------------------------------------------------

const indexCache = new Map<string, ProjectIndex>();
const mapCache = new Map<string, ProjectMap>();

async function getOrCreateIndex(projectPath: string): Promise<{ index: ProjectIndex; map: ProjectMap }> {
  const existing = indexCache.get(projectPath);
  const existingMap = mapCache.get(projectPath);

  if (existing && existingMap && Date.now() - existing.indexedAt.getTime() < 5 * 60 * 1000) {
    return { index: existing, map: existingMap };
  }

  const index = await indexProject(projectPath);
  const map = generateProjectMap(index);
  indexCache.set(projectPath, index);
  mapCache.set(projectPath, map);
  return { index, map };
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

export async function loopRoutes(fastify: FastifyInstance): Promise<void> {
  const llm = new LLMProvider({
    anthropicApiKey: process.env.ANTHROPIC_API_KEY,
    nebiusApiKey:    process.env.NEBIUS_API_KEY,
    geminiApiKey:    process.env.GEMINI_API_KEY,
  });

  // --------------------------------------------------------------------------
  // POST /decompose — turn a user prompt into a PRD checklist
  // --------------------------------------------------------------------------
  fastify.post<{ Body: { message: string; projectPath: string } }>(
    "/decompose",
    async (request, reply) => {
      const { message, projectPath } = request.body;
      if (!message || !projectPath) {
        return reply.status(400).send({ error: "message and projectPath are required" });
      }

      try {
        const { map } = await getOrCreateIndex(projectPath);
        const projectContext = serializeMapForLLM(map);
        const prdContent = await decompose(llm, message, projectContext);
        const tasks = parseTasks(prdContent);
        const warnings = validatePrd(prdContent);

        return { data: { prdContent, tasks, warnings } };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        fastify.log.error(err, "Decompose failed");
        return reply.status(500).send({ error: "DecomposeError", message: msg });
      }
    }
  );

  // --------------------------------------------------------------------------
  // POST /start — start a loop session
  // --------------------------------------------------------------------------
  fastify.post<{ Body: LoopConfig }>(
    "/start",
    async (request, reply) => {
      const config = request.body;

      if (!config.prdContent || !config.projectPath) {
        return reply.status(400).send({ error: "prdContent and projectPath are required" });
      }

      const tasks = parseTasks(config.prdContent);
      if (tasks.length === 0) {
        return reply.status(400).send({ error: "PRD contains no tasks (use '- [ ] task' format)" });
      }

      const warnings = validatePrd(config.prdContent);
      const sessionId = `ralph-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

      const session: LoopSession = {
        id: sessionId,
        config,
        status: "running",
        prdContent: config.prdContent,
        tasks,
        currentIteration: 0,
        currentTask: null,
        pendingResult: null,
        totalCost: 0,
        totalTokens: { input: 0, output: 0 },
        iterations: [],
        startedAt: new Date().toISOString(),
        _decisionResolver: null,
        _cancelRequested: false,
      };

      const entry: SessionEntry = { session, events: [], subscribers: new Set() };
      sessions.set(sessionId, entry);

      // Clean up session after 1 hour regardless of outcome
      setTimeout(() => cleanupSession(sessionId), 3_600_000);

      // Start the loop as a detached async process
      (async () => {
        try {
          const { index, map } = await getOrCreateIndex(config.projectPath);
          const service = new AssistService(llm, index, map);

          for await (const event of runLoop(session, service, llm)) {
            broadcastEvent(entry, event);

            // Close SSE connections on loop end
            if (event.type === "loop:end") {
              setTimeout(() => {
                for (const res of entry.subscribers) {
                  try { res.end(); } catch { /* ignore */ }
                }
                entry.subscribers.clear();
              }, 500); // small delay so clients receive the final event
            }
          }
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          fastify.log.error(err, `[loop:${sessionId}] Unhandled error`);
          broadcastEvent(entry, { type: "loop:end", reason: "failed" });
          session.status = "failed";
          session.endedAt = new Date().toISOString();
        }
      })();

      const { completed, total } = getCompletionStatus(tasks);
      return reply.status(201).send({
        data: {
          sessionId,
          status: session.status,
          taskCount: total,
          tasksCompleted: completed,
          validationWarnings: warnings,
          eventsUrl: `/api/loop/events/${sessionId}`,
        },
      });
    }
  );

  // --------------------------------------------------------------------------
  // GET /events/:id — SSE stream
  // --------------------------------------------------------------------------
  fastify.get<{ Params: { id: string } }>(
    "/events/:id",
    async (request, reply) => {
      const entry = sessions.get(request.params.id);
      if (!entry) {
        return reply.status(404).send({ error: "Session not found" });
      }

      const res = reply.raw;
      res.writeHead(200, {
        "Content-Type":  "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection":    "keep-alive",
        "X-Accel-Buffering": "no", // disable nginx buffering if present
      });

      // Replay buffered events for late joiners
      for (const event of entry.events) {
        res.write(`data: ${JSON.stringify(event)}\n\n`);
      }

      // If the session is already done, close immediately after replay
      const terminalStatuses = ["completed", "failed", "cancelled"];
      if (terminalStatuses.includes(entry.session.status)) {
        res.end();
        return reply;
      }

      // Register as a subscriber
      entry.subscribers.add(res);

      // Keepalive ping every 15s to prevent proxy timeouts
      const keepalive = setInterval(() => {
        try { res.write(": ping\n\n"); } catch { clearInterval(keepalive); }
      }, 15_000);

      request.socket.on("close", () => {
        clearInterval(keepalive);
        entry.subscribers.delete(res);
      });

      return reply;
    }
  );

  // --------------------------------------------------------------------------
  // GET /status/:id — session snapshot
  // --------------------------------------------------------------------------
  fastify.get<{ Params: { id: string } }>(
    "/status/:id",
    async (request, reply) => {
      const entry = sessions.get(request.params.id);
      if (!entry) return reply.status(404).send({ error: "Session not found" });

      const { session } = entry;
      const { completed, total } = getCompletionStatus(session.tasks);

      return {
        data: {
          sessionId: session.id,
          status: session.status,
          currentIteration: session.currentIteration,
          currentTask: session.currentTask?.text ?? null,
          tasksCompleted: completed,
          tasksTotal: total,
          totalCost: session.totalCost,
          prdContent: session.prdContent,
          tasks: session.tasks,
          // Return iteration summaries (omit full assistResponse to keep payload small)
          iterations: session.iterations.map(({ assistResponse: _, ...rest }) => rest),
          startedAt: session.startedAt,
          endedAt: session.endedAt,
        },
      };
    }
  );

  // --------------------------------------------------------------------------
  // POST /decide/:id — human decision
  // --------------------------------------------------------------------------
  fastify.post<{
    Params: { id: string };
    Body: { decision: HumanDecision };
  }>(
    "/decide/:id",
    async (request, reply) => {
      const entry = sessions.get(request.params.id);
      if (!entry) return reply.status(404).send({ error: "Session not found" });

      const { session } = entry;
      const { decision } = request.body;

      if (!["accept", "retry", "skip", "stop"].includes(decision)) {
        return reply.status(400).send({ error: "decision must be accept | retry | skip | stop" });
      }

      if (session.status !== "paused") {
        return reply.status(409).send({
          error: "Session is not paused",
          status: session.status,
        });
      }

      if (!session._decisionResolver) {
        return reply.status(409).send({ error: "No pending decision" });
      }

      session._decisionResolver(decision);

      return { data: { sessionId: session.id, decision } };
    }
  );

  // --------------------------------------------------------------------------
  // POST /cancel/:id — force cancel
  // --------------------------------------------------------------------------
  fastify.post<{ Params: { id: string } }>(
    "/cancel/:id",
    async (request, reply) => {
      const entry = sessions.get(request.params.id);
      if (!entry) return reply.status(404).send({ error: "Session not found" });

      const { session } = entry;
      session._cancelRequested = true;

      // If paused waiting for human, unblock with "stop"
      if (session.status === "paused" && session._decisionResolver) {
        session._decisionResolver("stop");
      }

      return { data: { sessionId: session.id, status: "cancelling" } };
    }
  );

  // --------------------------------------------------------------------------
  // GET /sessions — list all sessions
  // --------------------------------------------------------------------------
  fastify.get("/sessions", async () => {
    const list = Array.from(sessions.values()).map(({ session }) => {
      const { completed, total } = getCompletionStatus(session.tasks);
      return {
        sessionId: session.id,
        status: session.status,
        currentIteration: session.currentIteration,
        tasksCompleted: completed,
        tasksTotal: total,
        totalCost: session.totalCost,
        startedAt: session.startedAt,
        endedAt: session.endedAt,
      };
    });
    return { data: list };
  });
}
