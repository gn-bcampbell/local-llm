import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const backendPort = env.VITE_BACKEND_PORT ?? "8000";

  return {
    plugins: [react()],
    server: {
      port: Number(env.VITE_DEV_PORT ?? 5173),
      proxy: {
        "/api": {
          target: env.VITE_API_BASE ?? `http://localhost:${backendPort}`,
          changeOrigin: true
        }
      }
    },
    preview: {
      port: Number(env.VITE_PREVIEW_PORT ?? 4173)
    }
  };
});
