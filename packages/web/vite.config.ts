import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import path from "node:path";

export default defineConfig({
  plugins: [react()],
  build: {
    rollupOptions: {
      input: {
        main: path.resolve(import.meta.dirname, "index.html"),
        tv: path.resolve(import.meta.dirname, "tv/index.html")
      }
    }
  },
  server: {
    proxy: {
      "/api": {
        target: "http://127.0.0.1:3010",
        ws: true
      },
      "/health": "http://127.0.0.1:3010"
    }
  }
});
