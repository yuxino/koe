import { createServer } from "./index.js";

const { server, config, jobs } = createServer();
server.listen(config.port, "127.0.0.1", () => {
  console.log(`[koe] listening on http://127.0.0.1:${config.port} (${config.provider})`);
});

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  const active = jobs.abortAll();
  console.log(`[koe] ${signal} received, cancelling ${active} active job(s) and saving partial subtitles`);
  await jobs.savePartialCaches();
  await new Promise((resolve) => setTimeout(resolve, 400));
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
