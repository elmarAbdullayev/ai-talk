import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { defineConfig, type Plugin } from "vite";

const api = "http://127.0.0.1:8070";

/**
 * Development only: lets the page save a picture of the canvas into .captures/ (POST /__capture).
 * Used to check the avatar from tests in a browser without camera or microphone.
 */
function captures(): Plugin {
  return {
    name: "ai-talk-captures",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use("/__capture", (req, res) => {
        const url = new URL(req.url ?? "", "http://x");
        const name = (url.searchParams.get("name") ?? "capture").replace(/[^a-z0-9_-]/gi, "") || "capture";
        let body = "";
        req.setEncoding("utf8");
        req.on("data", (chunk: string) => (body += chunk));
        req.on("end", () => {
          const match = /^data:image\/(png|jpeg);base64,(.+)$/.exec(body);
          if (!match) {
            res.statusCode = 400;
            res.end("expected an image data URL");
            return;
          }
          const dir = join(server.config.root, ".captures");
          mkdirSync(dir, { recursive: true });
          const file = join(dir, `${name}.${match[1] === "png" ? "png" : "jpg"}`);
          writeFileSync(file, match[2], "base64");
          res.end(file);
        });
      });
    },
  };
}

export default defineConfig({
  plugins: [captures()],
  server: {
    port: 5175,
    strictPort: true,
    proxy: { "/api": api },
  },
  build: {
    chunkSizeWarningLimit: 1500,
    rollupOptions: {
      // three.js in its own file: it changes rarely, so the browser keeps it cached
      output: { manualChunks: { three: ["three"] } },
    },
  },
});
