import { defineConfig } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import { apiPlugin } from "./api-plugin.ts";

export default defineConfig({
  plugins: [svelte(), apiPlugin()],
  server: {
    port: 7777,
    strictPort: true,
    open: true,
  },
});
