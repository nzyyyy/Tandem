import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwind from "@tailwindcss/vite";
export default defineConfig(({ command }) => ({
  root: "renderer",
  base: "./",
  plugins: [
    react(),
    tailwind(),
    {
      name: "dev-csp",
      transformIndexHtml: (html) =>
        command === "serve"
          ? html.replace("script-src 'self'", "script-src 'self' 'unsafe-inline'")
          : html,
    },
  ],
  build: { outDir: "../dist/app/renderer", emptyOutDir: true },
  server: { host: "127.0.0.1", port: 5173, strictPort: true },
}));
