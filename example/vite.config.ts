import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

// VITE_CONVEX_URL comes from .env.local, which `npx convex dev` writes. DEMO_PORT moves the page
// off 5173 when something else already holds it; the Playwright config reads the same variable.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  // Bound to the IPv4 loopback explicitly so the Playwright config and the browser agree with it;
  // `localhost` can resolve to ::1 on macOS while the test polls 127.0.0.1.
  server: { host: "127.0.0.1", port: Number(process.env.DEMO_PORT ?? 5173), strictPort: true },
});
