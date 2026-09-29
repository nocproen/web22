import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Playwright spawns a real Chromium and ws handles raw sockets; keep them out of the server bundle.
  serverExternalPackages: ["playwright", "playwright-core", "ws", "bufferutil", "utf-8-validate"],
};

export default nextConfig;
