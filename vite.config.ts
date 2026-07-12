import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig(({ command }) => ({
  // Served from https://<user>.github.io/unfold/ in production — dev keeps root.
  base: command === "build" ? "/unfold/" : "/",
  plugins: [react()],
  // Prefer 5173 but respect an assigned PORT (e.g. when 5173 is taken).
  server: { port: process.env.PORT ? Number(process.env.PORT) : 5173 },
  build: { chunkSizeWarningLimit: 2000 },
}));
