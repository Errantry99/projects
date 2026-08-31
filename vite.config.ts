import { defineConfig } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";

// Two targets from one core (see architecture record, D1):
//   default  — the plugin host, assets emitted normally
//   single   — everything inlined into one self-contained HTML file, no
//              plugin runtime, no network requests. This is the artifact
//              you can send someone as a link.
export default defineConfig(({ mode }) => {
  const single = mode === "single";
  return {
    plugins: single ? [viteSingleFile({ removeViteModuleLoader: true })] : [],
    define: { __PLUGIN_HOST__: JSON.stringify(!single) },
    build: {
      outDir: single ? "dist/single" : "dist/app",
      emptyOutDir: true,
      target: "es2022",
      cssCodeSplit: !single,
      assetsInlineLimit: single ? 100_000_000 : 4096,
    },
    test: {
      environment: "node",
      include: ["test/**/*.test.ts"],
    },
  };
});
