import assert from "node:assert/strict";
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createSession, shutdownSessions } from "./session.ts";
import type { SerialProfile } from "../types.ts";

test("pre-login console output stays out of the public session buffer", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-devices-session-"));
  const command = join(dir, "ssh");
  await writeFile(command, "#!/bin/sh\nprintf 'Terminal ready\\r\\nD2000 login: '\nsleep 2\n");
  await chmod(command, 0o755);
  const config = join(dir, "devices.json");
  await writeFile(config, JSON.stringify({ version: 1, devices: [{ id: "fixture-host", host: "127.0.0.1", defaultUser: "tester" }], profiles: [] }));
  const previousPath = process.env.PATH;
  const previousConfig = process.env.PI_DEVICES_CONFIG;
  process.env.PATH = `${dir}:${previousPath ?? ""}`;
  process.env.PI_DEVICES_CONFIG = config;
  const profile: SerialProfile = { id: "fixture", transport: { type: "remote", device: "fixture-host" }, port: "/dev/ttyUSB0", baud: 115200, username: "root", credentialRef: "fixture" };
  let session: Awaited<ReturnType<typeof createSession>> | undefined;
  try {
    session = await createSession(profile);
    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.equal(session.state, "login-required");
    assert.equal(session.output, "");
    assert.equal(session.consoleBytes, 0);
  } finally {
    session?.transport.kill();
    shutdownSessions();
    if (previousPath === undefined) delete process.env.PATH; else process.env.PATH = previousPath;
    if (previousConfig === undefined) delete process.env.PI_DEVICES_CONFIG; else process.env.PI_DEVICES_CONFIG = previousConfig;
  }
});
