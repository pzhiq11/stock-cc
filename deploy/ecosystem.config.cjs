module.exports = {
  apps: [
    {
      name: "stocklens",
      cwd: require("node:path").resolve(__dirname, ".."),
      script: "node_modules/next/dist/bin/next",
      args: "start --hostname 127.0.0.1",
      instances: 1,
      exec_mode: "fork",
      autorestart: true,
      max_memory_restart: "1G",
    },
  ],
};
