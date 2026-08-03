import path from "path";
import { gzipSync } from "zlib";
import { defineConfig, type Plugin } from "vite";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";

const KB = 1024;

const BUNDLE_LIMITS_GZIP: Array<{ pattern: RegExp; limit: number; label: string }> = [
  { pattern: /^index-.*\.js$/, limit: 300 * KB, label: "index entry" },
  { pattern: /policy/i, limit: 200 * KB, label: "PolicyEditor chunk" },
  { pattern: /\.js$/, limit: 100 * KB, label: "js chunk" },
  { pattern: /\.css$/, limit: 100 * KB, label: "css chunk" },
];

function bundleSizeGuard(): Plugin {
  return {
    name: "firefik-bundle-size-guard",
    apply: "build",
    enforce: "post",
    generateBundle(_options, bundle) {
      const failures: string[] = [];
      for (const [fileName, chunk] of Object.entries(bundle)) {
        if (chunk.type !== "chunk" && chunk.type !== "asset") continue;
        const baseName = fileName.split("/").pop() ?? fileName;
        const source =
          chunk.type === "chunk"
            ? Buffer.from(chunk.code, "utf8")
            : Buffer.isBuffer(chunk.source)
              ? chunk.source
              : Buffer.from(chunk.source as string);
        if (!/\.(js|css)$/.test(baseName)) continue;
        const gz = gzipSync(source).byteLength;
        const rule = BUNDLE_LIMITS_GZIP.find((r) => r.pattern.test(baseName));
        if (!rule) continue;
        const kb = (gz / KB).toFixed(1);
        const limitKb = (rule.limit / KB).toFixed(0);
        if (gz > rule.limit) {
          failures.push(`${baseName} = ${kb} kB gzip exceeds ${rule.label} limit ${limitKb} kB`);
        } else {
          this.info?.(`bundle-size-guard: ${baseName} ${kb} kB gzip (limit ${limitKb} kB)`);
        }
      }
      if (failures.length > 0) {
        this.error(`bundle-size-guard FAIL:\n  - ${failures.join("\n  - ")}`);
      }
    },
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss(), bundleSizeGuard()],
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "./src"),
    },
  },
  build: {
    chunkSizeWarningLimit: 1000,
  },
});
