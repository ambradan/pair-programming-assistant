import Fastify, { FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import path from "path";
import { fileURLToPath } from "url";
import { assistRoutes } from "./routes/assist.routes.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: process.env.NODE_ENV === "development" ? "info" : "warn",
      transport:
        process.env.NODE_ENV === "development"
          ? { target: "pino-pretty" }
          : undefined,
    },
  });

  // CORS for local dev
  await app.register(cors, {
    origin: true,
  });

  // Serve web UI
  await app.register(fastifyStatic, {
    root: path.join(__dirname, "..", "web", "public"),
    prefix: "/",
  });

  // API routes
  await app.register(assistRoutes, { prefix: "/api" });

  return app;
}
