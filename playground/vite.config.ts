import { fileURLToPath } from "node:url";

import babel from "@rolldown/plugin-babel";
import react, { reactCompilerPreset } from "@vitejs/plugin-react";
import { defineConfig, searchForWorkspaceRoot } from "vite";

export default defineConfig({
  base: "./",
  build: {
    chunkSizeWarningLimit: 850,
  },
  plugins: [react(), babel({ presets: [reactCompilerPreset()] })],
  resolve: {
    alias: {
      "@mewhhaha/baba/runtime/generated-wasm": fileURLToPath(
        new URL("./node_modules/@mewhhaha/baba/src/runtime/generated_wasm.js", import.meta.url),
      ),
    },
    dedupe: ["react", "react-dom"],
  },
  server: {
    fs: {
      allow: [
        searchForWorkspaceRoot(process.cwd()),
        fileURLToPath(new URL("../", import.meta.url)),
      ],
    },
  },
});
