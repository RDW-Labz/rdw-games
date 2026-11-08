import { defineConfig } from "vitest/config";
import packageJson from "./package.json" with { type: "json" };

export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify(packageJson.version),
  },
  build: {
    outDir: "build/web",
  },
  test: {
    globals: true,
  },
});
