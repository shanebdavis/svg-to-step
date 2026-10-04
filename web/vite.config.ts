import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  // Relative asset URLs, so the build works from any host path.
  base: "./",
  plugins: [react()],
  worker: { format: "es" },
  optimizeDeps: { exclude: ["replicad-opencascadejs"] },
  test: { environment: "node", testTimeout: 120_000 },
});
