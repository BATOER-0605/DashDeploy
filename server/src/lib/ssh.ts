import { readFileSync } from "node:fs";
import { Client, type ConnectConfig } from "ssh2";
import { resolvePrivateKeyPath, type ServerEntry } from "../inventory.js";
import { makeLineSplitter } from "./lines.js";

export type SshStream = "stdout" | "stderr";

export class SshError extends Error {}

function connectConfig(server: ServerEntry): ConnectConfig {
  const { ssh } = server;
  const base: ConnectConfig = {
    host: ssh.host,
    port: ssh.port,
    username: ssh.user,
    readyTimeout: 20_000,
  };
  if (ssh.auth === "password") {
    return { ...base, password: ssh.password };
  }
  return {
    ...base,
    privateKey: readFileSync(resolvePrivateKeyPath(ssh.privateKeyPath!)),
    passphrase: ssh.passphrase || undefined,
  };
}

/**
 * Run a command on the target over SSH, streaming output line by line.
 * Resolves with the remote exit code (non-zero means the command failed).
 */
export function runCommand(
  server: ServerEntry,
  command: string,
  onLine: (stream: SshStream, line: string) => void,
): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const conn = new Client();
    let settled = false;
    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      conn.end();
      reject(err instanceof SshError ? err : new SshError(err.message));
    };

    conn
      .on("ready", () => {
        conn.exec(command, (err, stream) => {
          if (err) return fail(err);
          const out = makeLineSplitter((l) => onLine("stdout", l));
          const errs = makeLineSplitter((l) => onLine("stderr", l));
          let exitCode = 0;
          stream
            .on("data", (d: Buffer) => out.push(d))
            .on("close", (code: number | null) => {
              out.flush();
              errs.flush();
              if (settled) return;
              settled = true;
              conn.end();
              resolve(code ?? exitCode);
            });
          stream.stderr.on("data", (d: Buffer) => errs.push(d));
          stream.on("exit", (code: number | null) => {
            if (typeof code === "number") exitCode = code;
          });
        });
      })
      .on("error", fail)
      .connect(connectConfig(server));
  });
}

/** Run a command and return trimmed stdout (used for short queries like `tailscale ip -4`). */
export async function captureCommand(server: ServerEntry, command: string): Promise<string> {
  let stdout = "";
  const code = await runCommand(server, command, (stream, line) => {
    if (stream === "stdout") stdout += line + "\n";
  });
  if (code !== 0) {
    throw new SshError(`command exited with code ${code}: ${command}`);
  }
  return stdout.trim();
}
