import { spawn as childSpawn } from "node:child_process";
import * as crypto from "node:crypto";
import { spawn as ptySpawn } from "node-pty";
import { getRemoteDevice } from "../remote/config.ts";
import { resolveSshRouteArgs } from "../remote/ssh-route.ts";
import { OsSerialCredentialStore, type SerialProfile } from "./profiles.ts";

const DEFAULT_BAUD = 115200;
const DEFAULT_TIMEOUT_S = 30;
const MAX_TIMEOUT_S = 600;
const MAX_BUFFER_LINES = 2000;
const MAX_BUFFER_BYTES = 256 * 1024;
const MARKER_PREFIX = "__PI_SERIAL_DONE_";
const VALID_PORT_RE = /^\/dev\/[a-zA-Z0-9._\-/]+$/;

export type SerialExecResult = { stdout: string; exitCode: number; durationMs: number; timedOut: boolean };
export type SerialState = "connecting" | "login-required" | "authenticating" | "shell-ready" | "bootloader" | "stale";
export type SerialTransport = {
  write(data: string): void;
  onData(callback: (data: string) => void): { dispose(): void };
  onExit(callback: (reason?: string) => void): void;
  kill(): void;
};
export type SerialSession = {
  profile: SerialProfile;
  transport: SerialTransport;
  state: SerialState;
  rawTail: string;
  output: string;
  password?: string;
  error?: string;
  transportReady: boolean;
  consoleBytes: number;
};

const sessions = new Map<string, SerialSession>();
const locks = new Map<string, Promise<void>>();

function shellQuote(value: string): string { return `'${value.replace(/'/g, "'\\''")}'`; }
function sleep(ms: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, ms)); }
function marker(): string { return `${MARKER_PREFIX}${crypto.randomBytes(6).toString("hex")}_`; }
function validateLocalProfile(profile: SerialProfile): void { if (!VALID_PORT_RE.test(profile.port)) throw new Error(`串口路径不合法: ${profile.port}`); }
function redact(session: SerialSession, text: string): string { return session.password ? text.replaceAll(session.password, "[REDACTED]") : text; }
function appendOutput(session: SerialSession, text: string): void {
  session.output = redact(session, (session.output + text).replace(/\r\n?/g, "\n")).slice(-MAX_BUFFER_BYTES);
  const lines = session.output.split("\n");
  if (lines.length > MAX_BUFFER_LINES) session.output = lines.slice(-MAX_BUFFER_LINES).join("\n");
}
function detectState(session: SerialSession): void {
  const text = session.rawTail.split(/\r?\n/).filter((line) => line.trim()).at(-1) ?? "";
  if (new RegExp(session.profile.prompts?.password ?? "(?:password|密码)\\s*[:：]", "i").test(text)) session.state = "authenticating";
  else if (new RegExp(session.profile.prompts?.login ?? "(?:login|username|用户名)\\s*[:：]", "i").test(text)) session.state = "login-required";
  else if (/\b=>\s*$|^u-boot[\s>]*$/i.test(text)) session.state = "bootloader";
}
function localTransport(command: string, args: string[]): SerialTransport {
  const pty = ptySpawn(command, args, { name: "xterm", cols: 200, rows: 50, cwd: process.cwd(), env: process.env });
  return { write: (data) => pty.write(data), onData: (callback) => pty.onData(callback), kill: () => pty.kill(), onExit: (callback) => { pty.onExit(() => callback()); } };
}
function remoteTransport(profile: SerialProfile, command: string): SerialTransport {
  if (profile.transport.type !== "remote" || !profile.transport.device) throw new Error(`serial profile ${profile.id} 缺少 remote transport device`);
  const remoteCommand = `${shellQuote(command)} ${shellQuote(profile.port)} -b ${profile.baud || DEFAULT_BAUD}`;
  const device = getRemoteDevice(profile.transport.device);
  const child = childSpawn("ssh", resolveSshRouteArgs(device, remoteCommand, { interactive: true }), { stdio: ["pipe", "pipe", "pipe"] });
  const listeners = new Set<(data: string) => void>();
  child.stdout.on("data", (data) => { for (const listener of listeners) listener(data.toString()); });
  let diagnostics = "";
  child.stderr.on("data", (data) => { diagnostics = (diagnostics + data.toString()).slice(-500); });
  child.on("error", () => {});
  child.stdin.on("error", () => {});
  return {
    write: (data) => { if (!child.stdin.writable) throw new Error("serial-transport-lost"); child.stdin.write(data); },
    onData: (callback) => { listeners.add(callback); return { dispose: () => listeners.delete(callback) }; },
    kill: () => child.kill(),
    onExit: (callback) => { child.on("close", () => callback(diagnostics.trim() || "SSH connection closed")); child.on("error", () => callback("SSH process failed")); },
  };
}

export async function createSession(profile: SerialProfile): Promise<SerialSession> {
  const command = profile.picocom?.command || "picocom";
  try {
    if (profile.transport.type === "local") validateLocalProfile(profile);
    const transport = profile.transport.type === "remote" ? remoteTransport(profile, command) : localTransport(command, [profile.port, "-b", String(profile.baud || DEFAULT_BAUD)]);
    const session: SerialSession = { profile, transport, state: "connecting", rawTail: "", output: "", transportReady: false, consoleBytes: 0 };
    transport.onData((text) => {
      if (session.transportReady) session.consoleBytes += Buffer.byteLength(text);
      session.rawTail = (session.rawTail + text).slice(-4096);
      if (session.rawTail.includes("Terminal ready")) session.transportReady = true;
      if (session.state === "shell-ready") appendOutput(session, text); else detectState(session);
    });
    transport.onExit((reason) => { session.error = reason ? redact(session, reason).slice(-500) : undefined; session.state = "stale"; });
    return session;
  } catch (error: any) { throw new Error(`serial-transport-unavailable: ${error?.message ?? String(error)}`); }
}

export async function ensureSession(profile: SerialProfile): Promise<SerialSession> {
  const existing = sessions.get(profile.id);
  if (existing && existing.state !== "stale") return existing;
  existing?.transport.kill();
  const session = await createSession(profile);
  sessions.set(profile.id, session);
  return session;
}

async function waitFor(session: SerialSession, predicate: () => boolean, timeoutMs: number, signal?: AbortSignal): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (signal?.aborted) throw new Error("serial-cancelled");
    if (session.state === "stale") throw new Error(`serial-transport-lost: ${session.profile.id}`);
    if (session.state === "bootloader") throw new Error(`serial-bootloader-detected: ${session.profile.id}`);
    if (predicate()) return true;
    await sleep(50);
  }
  return false;
}
async function probeShell(session: SerialSession, signal?: AbortSignal): Promise<boolean> {
  const nonce = `__PI_SERIAL_READY_${crypto.randomBytes(6).toString("hex")}__`;
  session.rawTail = "";
  session.transport.write(`printf '\\n${nonce}\\n'\r`);
  const ready = await waitFor(session, () => new RegExp(`(?:^|\\n)${nonce}\\r?\\n`).test(session.rawTail), 3000, signal);
  if (ready) { session.state = "shell-ready"; session.rawTail = ""; }
  return ready;
}
export async function prepareShell(session: SerialSession, signal?: AbortSignal): Promise<void> {
  if (session.state === "shell-ready") return;
  await waitFor(session, () => session.state === "login-required" || session.state === "authenticating", 1200, signal);
  if (session.state === "connecting") { session.rawTail = ""; session.transport.write("\r"); await waitFor(session, () => session.state === "login-required" || session.state === "authenticating", 2500, signal); }
  if (session.state === "connecting") { if (await probeShell(session, signal)) return; throw new Error(`serial-shell-unconfirmed: ${session.profile.id}`); }
  const credential = await new OsSerialCredentialStore().get(session.profile.credentialRef);
  if (!credential || credential.username !== session.profile.username) throw new Error(`serial-credential-required: ${session.profile.id}`);
  session.password = credential.password;
  if (session.state === "login-required") { session.rawTail = ""; session.transport.write(`${credential.username}\r`); await waitFor(session, () => session.state === "authenticating", 5000, signal); }
  if (session.state === "authenticating") {
    session.rawTail = "";
    session.state = "connecting";
    session.transport.write(`${credential.password}\r`);
    await sleep(300);
    if ((session.state as string) === "login-required" || /login incorrect|登录错误|认证失败/i.test(session.rawTail)) throw new Error(`serial-login-failed: ${session.profile.id}`);
  }
  if (!await probeShell(session, signal)) throw new Error(`serial-shell-unconfirmed: ${session.profile.id}`);
}
async function withProfileLock<T>(id: string, fn: () => Promise<T>): Promise<T> {
  const previous = locks.get(id) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => { release = resolve; });
  locks.set(id, current);
  await previous;
  try { return await fn(); } finally { release(); if (locks.get(id) === current) locks.delete(id); }
}
export async function execProfile(profile: SerialProfile, command: string, timeoutSeconds = DEFAULT_TIMEOUT_S, signal?: AbortSignal): Promise<SerialExecResult> {
  return withProfileLock(profile.id, async () => {
    const session = await ensureSession(profile);
    await prepareShell(session, signal);
    const id = marker();
    const start = Date.now();
    let commandOutput = "";
    const full = `${command}; printf '\\n${id}%s__\\n' "$?"`;
    return new Promise((resolve) => {
      let settled = false;
      let subscription: { dispose(): void } | undefined;
      const finish = (result: SerialExecResult) => { if (settled) return; settled = true; clearTimeout(timer); clearInterval(lost); subscription?.dispose(); signal?.removeEventListener("abort", abort); resolve(result); };
      const onData = (text: string) => { commandOutput = redact(session, commandOutput + text).slice(-MAX_BUFFER_BYTES); const match = commandOutput.match(new RegExp(`${id}(\\d+)__`)); if (!match) return; const output = commandOutput.replace(new RegExp(`\\r?\\n${id}\\d+__\\r?\\n?`), ""); finish({ stdout: output.trim(), exitCode: Number(match[1]), durationMs: Date.now() - start, timedOut: false }); };
      const abort = () => {
        if (settled) return;
        if (session.state !== "stale") {
          try { session.transport.write("\u0003"); } catch { session.error = "serial transport rejected cancellation"; }
        }
        session.state = "stale";
        finish({ stdout: commandOutput.trim(), exitCode: -1, durationMs: Date.now() - start, timedOut: true });
      };
      const timer = setTimeout(abort, Math.min(Math.max(1, timeoutSeconds), MAX_TIMEOUT_S) * 1000);
      const lost = setInterval(() => { if (session.state === "stale") abort(); }, 100);
      signal?.addEventListener("abort", abort, { once: true });
      subscription = session.transport.onData(onData);
      try { session.transport.write(`${full}\r`); } catch { abort(); }
    });
  });
}
export function getSession(id: string): SerialSession | undefined { return sessions.get(id); }
export function shutdownSessions(): void { for (const session of sessions.values()) session.transport.kill(); sessions.clear(); }
export function dangerousReason(command: string): string | undefined { return /\b(reboot|shutdown|poweroff|halt|mkfs|dd)\b|\brm\s+-[^\n]*(r|f)/i.test(command) ? "疑似破坏性命令" : undefined; }
export function formatResult(result: SerialExecResult): string { return `${result.stdout}${result.timedOut ? `\n[timeout ${Math.round(result.durationMs / 1000)}s]` : ""}\n[exit=${result.exitCode} duration=${result.durationMs}ms]`; }
