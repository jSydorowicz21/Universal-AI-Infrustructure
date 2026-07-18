import type { NextConfig } from "next";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = dirname(fileURLToPath(import.meta.url));

const nextConfig: NextConfig = {
  output: "export",
  distDir: "out",
  outputFileTracingRoot: rootDir,
  images: { unoptimized: true },
  typescript: { ignoreBuildErrors: true },
  generateBuildId: () => "pai-pulse-static",
};

export default nextConfig;
