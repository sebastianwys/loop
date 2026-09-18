// the red tests are the record of what is still open, so they are kept out of
// the green suite and run on purpose:
//   cd web && npx vitest run --config redtest.config.ts
import { defineConfig } from "vite";

export default defineConfig({
  test: { include: ["src/**/*.redtest.ts"], environment: "node" },
});
