import { createServer } from "./index.js";

const { server, config } = createServer();
server.listen(config.port, "127.0.0.1", () => {
  console.log(`[koe] listening on http://127.0.0.1:${config.port} (${config.provider}, ${config.mode})`);
});
