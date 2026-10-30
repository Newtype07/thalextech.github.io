import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";

const base = process.env.VITE_BASE_PATH || "/";
const proxyPath = `${base.replace(/\/$/, "")}/thalex-api`;
const proxy = {
  [proxyPath]: {
    target: "https://thalex.com",
    changeOrigin: true,
    rewrite: (path) => path.replace(proxyPath, "/api/v2/public"),
  },
};
export default defineConfig({
  base,
  plugins: [vue()],
  server: { proxy },
  preview: { proxy },
});
