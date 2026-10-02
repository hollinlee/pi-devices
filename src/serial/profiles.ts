import { execFile, spawn } from "node:child_process";
import { chmod, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { promisify } from "node:util";
import { readDevicesConfig, updateDevicesConfig, devicesConfigPath } from "../remote/config.ts";
import { SERIAL_CREDENTIAL_SERVICE_ENV, DEFAULT_SERIAL_CREDENTIAL_SERVICE } from "./constants.ts";
import type { SerialProfile } from "../types.ts";
export type { SerialProfile } from "../types.ts";

const execFileAsync = promisify(execFile);
export const SERIAL_CREDENTIAL_SERVICE = process.env[SERIAL_CREDENTIAL_SERVICE_ENV] || DEFAULT_SERIAL_CREDENTIAL_SERVICE;
export const SERIAL_PROFILES_PATH = devicesConfigPath();

export interface SerialCredentialStore {
  get(ref: string): Promise<{ username: string; password: string } | undefined>;
  set(ref: string, username: string, password: string): Promise<void>;
}

function account(env: NodeJS.ProcessEnv = process.env): string {
  const value = env.USER || env.LOGNAME;
  if (!value) throw new Error("无法确定当前本机用户，不能访问 secure storage");
  return value;
}

function runSecretTool(args: string[], input?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("secret-tool", args, { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolve(stdout.trim()) : reject(new Error(stderr.trim() || `secret-tool exit=${code}`)));
    child.stdin.end(input);
  });
}

export class OsSerialCredentialStore implements SerialCredentialStore {
  private readonly platform: NodeJS.Platform;
  private readonly env: NodeJS.ProcessEnv;
  constructor(platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env) {
    this.platform = platform;
    this.env = env;
  }
  async get(ref: string): Promise<{ username: string; password: string } | undefined> {
    try {
      if (this.platform === "darwin") {
        const { stdout } = await execFileAsync("security", ["find-generic-password", "-a", account(this.env), "-s", `${SERIAL_CREDENTIAL_SERVICE}.${ref}`, "-w"], { env: this.env, encoding: "utf8" });
        const parsed = JSON.parse(stdout.trim()) as { username?: string; password?: string };
        return parsed.username && parsed.password ? { username: parsed.username, password: parsed.password } : undefined;
      }
      if (this.platform === "linux") {
        const raw = await runSecretTool(["lookup", "service", SERIAL_CREDENTIAL_SERVICE, "account", ref]);
        const parsed = JSON.parse(raw) as { username?: string; password?: string };
        return parsed.username && parsed.password ? { username: parsed.username, password: parsed.password } : undefined;
      }
      throw new Error(`当前平台不支持 serial secure storage: ${this.platform}`);
    } catch (error) {
      if (error instanceof Error && error.message.includes("不支持")) throw error;
      return undefined;
    }
  }
  async set(ref: string, username: string, password: string): Promise<void> {
    const value = JSON.stringify({ username, password });
    if (this.platform === "darwin") {
      await execFileAsync("security", ["add-generic-password", "-a", account(this.env), "-s", `${SERIAL_CREDENTIAL_SERVICE}.${ref}`, "-w", value, "-U"], { env: this.env, encoding: "utf8" });
      return;
    }
    if (this.platform === "linux") {
      await runSecretTool(["store", "--label", `pi-devices serial ${ref}`, "service", SERIAL_CREDENTIAL_SERVICE, "account", ref], value);
      return;
    }
    throw new Error(`当前平台不支持 serial secure storage: ${this.platform}`);
  }
}

export function validateProfile(profile: unknown): SerialProfile {
  if (!profile || typeof profile !== "object" || Array.isArray(profile)) throw new Error("serial profile 必须是对象");
  const item = profile as Partial<SerialProfile>;
  if (!item.id || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(item.id)) throw new Error("serial profile id 不合法");
  if (!item.transport || (item.transport.type !== "local" && item.transport.type !== "remote")) throw new Error(`serial profile ${item.id} 的 transport.type 必须是 local 或 remote`);
  if (item.transport.type === "remote" && !item.transport.device) throw new Error(`serial profile ${item.id} 的 remote transport 必须指定 device`);
  if (!item.port || !/^\/dev\/[A-Za-z0-9._\-/]+$/.test(item.port)) throw new Error(`serial profile ${item.id} 的 port 不合法`);
  if (!Number.isFinite(item.baud) || (item.baud ?? 0) <= 0) throw new Error(`serial profile ${item.id} 的 baud 不合法`);
  if (!item.username || !item.credentialRef) throw new Error(`serial profile ${item.id} 必须指定 username 和 credentialRef`);
  return item as SerialProfile;
}

export async function readSerialProfiles(filePath = SERIAL_PROFILES_PATH): Promise<SerialProfile[]> {
  try {
    const profiles = readDevicesConfig(filePath).profiles.map(validateProfile);
    if (new Set(profiles.map((profile) => profile.id)).size !== profiles.length) throw new Error("重复的 serial profile id");
    return profiles;
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") return [];
    throw error;
  }
}

export async function writeSerialProfiles(profiles: SerialProfile[], filePath = SERIAL_PROFILES_PATH): Promise<void> {
  const validated = profiles.map(validateProfile);
  updateDevicesConfig((current) => ({ ...current, profiles: validated }), filePath);
  await mkdir(dirname(filePath), { recursive: true, mode: 0o700 });
  await chmod(filePath, 0o600);
}

export function publicSerialProfile(profile: SerialProfile): Omit<SerialProfile, "credentialRef"> {
  const { credentialRef: _credentialRef, ...publicProfile } = profile;
  return publicProfile;
}

export async function resolveSerialProfile(id: string, filePath = SERIAL_PROFILES_PATH): Promise<SerialProfile> {
  const profile = (await readSerialProfiles(filePath)).find((item) => item.id === id);
  if (!profile) throw new Error(`未找到 serial profile: ${id}`);
  return profile;
}
