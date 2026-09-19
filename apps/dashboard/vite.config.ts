import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      // Dev convenience: relative API calls forward to the API when VITE_API_URL is unset.
      "/api": {
        target: process.env.VITE_API_URL ?? "http://localhost:3456",
        changeOrigin: true,
      },
    },
  },
  preview: { port: 4173 },
});
