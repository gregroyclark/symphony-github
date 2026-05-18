import http from "node:http";
import type { Orchestrator } from "./orchestrator/orchestrator.js";
import type { Logger } from "./logger.js";

export function startStatusServer(
  orchestrator: Orchestrator,
  port: number,
  logger: Logger
): http.Server {
  const server = http.createServer((request, response) => {
    if (request.url === "/status" || request.url === "/") {
      const body = JSON.stringify(orchestrator.snapshot(), null, 2);
      response.writeHead(200, {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Length": Buffer.byteLength(body)
      });
      response.end(body);
      return;
    }
    response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("not found\n");
  });

  server.listen(port, () => {
    const address = server.address();
    logger.info("Status server listening", { address });
  });

  return server;
}
