import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";

export default defineConfig({
  root: resolve(__dirname, "demo"),
  base: "./",
  publicDir: resolve(__dirname, "demo/public"),
  plugins: [react()],
  resolve: { alias: { "@": resolve(__dirname, "src/renderer/src") } },
  css: { postcss: __dirname },
  build: { outDir: resolve(__dirname, "demo-dist"), emptyOutDir: true },
});
