import dotenv from "dotenv";
dotenv.config();
import { buildApp } from "./app.js";

const PORT = parseInt(process.env.PPA_PORT ?? "3001", 10);
const HOST = process.env.HOST ?? "0.0.0.0";

async function start() {
  const app = await buildApp();

  try {
    await app.listen({ port: PORT, host: HOST });
    console.log(`\n🤖 Pair Programming Assistant running at http://${HOST}:${PORT}`);
    console.log(`   Web UI: http://${HOST}:${PORT}`);
    console.log(`   API:    http://${HOST}:${PORT}/api/status`);
    console.log(`   Assist: POST http://${HOST}:${PORT}/api/assist\n`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

start();
