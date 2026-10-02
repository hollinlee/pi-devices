import assert from "node:assert/strict";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { publicSerialProfile, readSerialProfiles, resolveSerialProfile, writeSerialProfiles, type SerialCredentialStore } from "./profiles.ts";
import type { SerialProfile } from "../types.ts";

const profile: SerialProfile = { id: "board-a", transport: { type: "remote", device: "compiler-server" }, port: "/dev/ttyUSB0", baud: 115200, username: "root", credentialRef: "board-a" };

test("serial profiles round-trip in unified config with private permissions", async () => {
  const file = join(await mkdtemp(join(tmpdir(), "pi-devices-serial-")), "devices.json");
  await writeSerialProfiles([profile], file);
  assert.deepEqual(await readSerialProfiles(file), [profile]);
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  assert.equal((await readFile(file, "utf8")).includes("password"), false);
  assert.deepEqual(JSON.parse(await readFile(file, "utf8")), { version: 1, devices: [], profiles: [profile], updatedAt: JSON.parse(await readFile(file, "utf8")).updatedAt });
});

test("profile resolution and public projection omit credential reference", async () => {
  const file = join(await mkdtemp(join(tmpdir(), "pi-devices-serial-")), "devices.json");
  await writeSerialProfiles([profile], file);
  const resolved = await resolveSerialProfile("board-a", file);
  assert.equal(resolved.id, "board-a");
  assert.equal("credentialRef" in publicSerialProfile(resolved), false);
  await assert.rejects(resolveSerialProfile("missing", file), /未找到/);
});

test("invalid profile and credential interface remain guarded", async () => {
  const file = join(await mkdtemp(join(tmpdir(), "pi-devices-serial-")), "devices.json");
  await assert.rejects(writeSerialProfiles([{ ...profile, transport: { type: "remote" } } as SerialProfile], file), /remote transport/);
  const store: SerialCredentialStore = { get: async () => ({ username: "root", password: "secret" }), set: async () => {} };
  assert.equal(typeof store.get, "function");
  assert.equal("password" in publicSerialProfile(profile), false);
});
