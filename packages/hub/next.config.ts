import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  transpilePackages: ["@noble/curves", "@noble/hashes"],
};

export default nextConfig;
