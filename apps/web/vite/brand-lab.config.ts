import * as NodeURL from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite-plus";
import { tailwindPlugins } from "./tailwind";

// Separate entry: no app bootstrap, auth, backend, desktop bridge, or saved preferences.
export default defineConfig({
  base: "./",
  publicDir: false,
  plugins: [...tailwindPlugins(false), react()],
  resolve: { alias: { "~": NodeURL.fileURLToPath(new URL("../src", import.meta.url)) } },
  server: { host: "127.0.0.1" },
  build: {
    outDir: "../../.showcase/brand-lab",
    rolldownOptions: {
      input: NodeURL.fileURLToPath(new URL("../brand-lab.html", import.meta.url)),
    },
  },
});
