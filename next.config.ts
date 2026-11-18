import type { NextConfig } from "next";

const config: NextConfig = {
  serverExternalPackages: ["pg", "@prisma/adapter-pg"],
};

export default config;
