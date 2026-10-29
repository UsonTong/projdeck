import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// 开发时把 /api 和 /ws 代理到本机 agentd；PROJDECK_AGENTD 可指向测试实例
const agentd = process.env.PROJDECK_AGENTD ?? "http://127.0.0.1:7420";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  // 终端引擎 ghostty-web 内嵌了 WASM，单独成块且已按需加载，体积在预期内
  build: { chunkSizeWarningLimit: 700 },
  server: {
    host: true,
    proxy: {
      "/api": agentd,
      "/ws": { target: agentd.replace(/^http/, "ws"), ws: true },
    },
  },
});
