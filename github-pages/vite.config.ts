import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  base: process.env.GITHUB_ACTIONS ? "/voicetrail/" : "/",
  publicDir: "../public",
  build: { outDir: "dist", emptyOutDir: true },
});

