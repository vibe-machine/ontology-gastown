import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";

// Throwaway local TypeDB server for the database tests: the `typedb` binary from
// TYPEDB_BIN, else from PATH (for example the Homebrew install), started on a free
// 127.0.0.1 port with its data and logs inside the caller's temporary directory.

const READY_TIMEOUT_MS = 60000;
const STOP_TIMEOUT_MS = 10000;

async function isFile(candidate) {
  try {
    return (await fs.stat(candidate)).isFile();
  } catch {
    return false;
  }
}

export async function resolveTypedbBinary() {
  if (process.env.TYPEDB_BIN) {
    if (await isFile(process.env.TYPEDB_BIN)) return process.env.TYPEDB_BIN;
    throw new Error(`TYPEDB_BIN is set but does not exist: ${process.env.TYPEDB_BIN}`);
  }
  for (const directory of (process.env.PATH ?? "").split(path.delimiter).filter(Boolean)) {
    const candidate = path.join(directory, "typedb");
    if (await isFile(candidate)) return candidate;
  }
  throw new Error("TypeDB executable not found: install TypeDB (for example `brew install typedb`) so `typedb` is on PATH, or set TYPEDB_BIN.");
}

async function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close((error) => error ? reject(error) : resolve(address.port));
    });
    server.on("error", reject);
  });
}

// "Ready!" can appear just before the gRPC port accepts connections, so also wait for the port.
async function waitForPort(port, deadline) {
  while (Date.now() < deadline) {
    const open = await new Promise((resolve) => {
      const socket = net.connect(port, "127.0.0.1");
      socket.once("connect", () => {
        socket.destroy();
        resolve(true);
      });
      socket.once("error", () => resolve(false));
    });
    if (open) return;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`TypeDB server printed "Ready!" but 127.0.0.1:${port} did not accept connections in time`);
}

export async function startTypedbServer(tempRoot) {
  const typedb = await resolveTypedbBinary();
  const grpcPort = await getFreePort();
  const args = [
    "server",
    "--server.address", `127.0.0.1:${grpcPort}`,
    "--server.http.enabled", "false",
    "--server.admin.enabled", "false",
    "--diagnostics.monitoring.enabled", "false",
    "--diagnostics.reporting.metrics", "false",
    "--diagnostics.reporting.errors", "false",
    "--storage.data-directory", path.join(tempRoot, "server-data"),
    "--logging.directory", path.join(tempRoot, "server-logs")
  ];

  const child = spawn(typedb, args, { cwd: tempRoot, stdio: ["ignore", "pipe", "pipe"] });
  const server = { child, grpcPort, typedb };
  const deadline = Date.now() + READY_TIMEOUT_MS;

  try {
    await new Promise((resolve, reject) => {
      let output = "";
      let ready = false;
      const timeout = setTimeout(() => {
        reject(new Error(`TypeDB server did not become ready within ${READY_TIMEOUT_MS / 1000}s.\n${output}`));
      }, READY_TIMEOUT_MS);

      // Keep draining both pipes for the server's lifetime so it never blocks on output.
      function onData(chunk) {
        if (ready) return;
        output += chunk.toString();
        if (output.includes("Ready!")) {
          ready = true;
          clearTimeout(timeout);
          resolve();
        }
      }

      child.stdout.on("data", onData);
      child.stderr.on("data", onData);
      child.on("exit", (code, signal) => {
        clearTimeout(timeout);
        if (!ready) reject(new Error(`TypeDB server exited early (code ${code}, signal ${signal}).\n${output}`));
      });
      child.on("error", (error) => {
        clearTimeout(timeout);
        reject(error);
      });
    });
    await waitForPort(grpcPort, deadline);
  } catch (error) {
    await stopTypedbServer(server);
    throw error;
  }

  console.log(`TypeDB server ready (pid ${child.pid}, 127.0.0.1:${grpcPort})`);
  return server;
}

export async function stopTypedbServer(server) {
  const child = server?.child;
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((resolve) => child.once("exit", resolve));
  child.kill("SIGTERM");
  const timedOut = await Promise.race([
    exited.then(() => false),
    new Promise((resolve) => setTimeout(() => resolve(true), STOP_TIMEOUT_MS))
  ]);
  if (timedOut) {
    child.kill("SIGKILL");
    await exited;
  }
  console.log(`TypeDB server stopped (pid ${child.pid})`);
}

export function runTypedbScript(server, scriptPath, cwd) {
  return spawnSync(server.typedb, [
    "console",
    `--address=127.0.0.1:${server.grpcPort}`,
    "--username=admin",
    "--password=password",
    "--tls-disabled",
    "--script", scriptPath
  ], { cwd, encoding: "utf8" });
}
