import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Proxy the backend API routes to the Node app (dockerized on :3000) so the SPA calls same-origin.
const api = "http://localhost:3000";
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/cars": api,
      "/sessions": api,
      "/engine-profiles": api,
    },
  },
});
