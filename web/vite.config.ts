import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  // Relative asset URLs, so the build works from any host path.
  base: "./",
  plugins: [react()],
  worker: { format: "es" },
  // three.js alone is ~600 kB; the app is one screen, so splitting buys nothing.
  build: { chunkSizeWarningLimit: 1200 },
  optimizeDeps: { exclude: ["replicad-opencascadejs"] },
  test: { environment: "node", testTimeout: 120_000 },
});
