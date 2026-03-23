/**
 * Embedded Web Server for Nexu Desktop
 *
 * Serves static files and proxies API requests to the Controller.
 * Runs in the Electron main process, eliminating the need for a separate Web sidecar.
 */

import { createReadStream } from "node:fs";
import { constants, access, stat } from "node:fs/promises";
import {
  type IncomingMessage,
  type ServerResponse,
  createServer,
} from "node:http";
import * as path from "node:path";

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html",
  ".js": "application/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".eot": "application/vnd.ms-fontobject",
};

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

async function collectBody(req: IncomingMessage): Promise<Uint8Array> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const buffer = Buffer.concat(chunks);
  // Convert to Uint8Array for fetch compatibility
  return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
}

async function proxyToController(
  req: IncomingMessage,
  res: ServerResponse,
  controllerUrl: string,
): Promise<void> {
  const targetUrl = `${controllerUrl}${req.url}`;

  try {
    let body: Uint8Array | undefined;
    if (req.method !== "GET" && req.method !== "HEAD") {
      body = await collectBody(req);
    }

    // Forward headers, filtering out host
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(req.headers)) {
      if (key.toLowerCase() === "host") continue;
      if (typeof value === "string") {
        headers[key] = value;
      } else if (Array.isArray(value)) {
        headers[key] = value.join(", ");
      }
    }

    const response = await fetch(targetUrl, {
      method: req.method,
      headers,
      body: body as BodyInit | undefined,
    });

    // Forward response headers
    const responseHeaders: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      responseHeaders[key] = value;
    });

    res.writeHead(response.status, responseHeaders);
    const resBody = await response.arrayBuffer();
    res.end(Buffer.from(resBody));
  } catch (err) {
    console.error("Proxy error:", err);
    res.writeHead(502);
    res.end("Bad Gateway");
  }
}

export interface EmbeddedWebServerOptions {
  port: number;
  webRoot: string;
  controllerPort: number;
}

export interface EmbeddedWebServer {
  close: () => Promise<void>;
}

/**
 * Start the embedded web server.
 */
export function startEmbeddedWebServer(
  opts: EmbeddedWebServerOptions,
): Promise<EmbeddedWebServer> {
  const { port, webRoot, controllerPort } = opts;
  const controllerUrl = `http://127.0.0.1:${controllerPort}`;

  return new Promise((resolve, reject) => {
    const server = createServer(async (req, res) => {
      const url = new URL(req.url ?? "/", `http://localhost:${port}`);

      // API proxy -> Controller (including /openapi.json)
      if (
        url.pathname.startsWith("/api") ||
        url.pathname.startsWith("/v1") ||
        url.pathname === "/openapi.json"
      ) {
        return proxyToController(req, res, controllerUrl);
      }

      // Static files
      let filePath = path.join(webRoot, url.pathname);

      // SPA fallback: if file doesn't exist or is directory, serve index.html
      const exists = await fileExists(filePath);
      if (!exists) {
        filePath = path.join(webRoot, "index.html");
      } else {
        try {
          const st = await stat(filePath);
          if (st.isDirectory()) {
            filePath = path.join(webRoot, "index.html");
          }
        } catch {
          filePath = path.join(webRoot, "index.html");
        }
      }

      const ext = path.extname(filePath);
      const contentType = MIME_TYPES[ext] || "application/octet-stream";

      try {
        const st = await stat(filePath);
        res.writeHead(200, {
          "Content-Type": contentType,
          "Content-Length": st.size,
        });
        createReadStream(filePath).pipe(res);
      } catch {
        res.writeHead(404);
        res.end("Not Found");
      }
    });

    server.on("error", (err) => {
      reject(err);
    });

    server.listen(port, "127.0.0.1", () => {
      console.log(`Embedded web server listening on http://127.0.0.1:${port}`);
      resolve({
        close: () =>
          new Promise<void>((closeResolve, closeReject) => {
            server.close((err) => {
              if (err) closeReject(err);
              else closeResolve();
            });
          }),
      });
    });
  });
}
