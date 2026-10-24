import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const backend = process.env.SNAPBRIDGE_BACKEND ?? "http://127.0.0.1:8000";

// `npm run dev` proxies API + WebSocket traffic to the FastAPI server and listens on all interfaces.
export default defineConfig({
  plugins: [react()],
  server: {
    host: true,
    proxy: { "/api": { target: backend, ws: true, changeOrigin: true } },
  },
});
