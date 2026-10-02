import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { OsSerialCredentialStore, publicSerialProfile, readSerialProfiles, resolveSerialProfile, SERIAL_CREDENTIAL_SERVICE, type SerialProfile } from "./profiles.ts";
import { dangerousReason, ensureSession, execProfile, formatResult, getSession, shutdownSessions } from "./session.ts";

function publicState(profile: SerialProfile) {
  const session = getSession(profile.id);
  return { profile: publicSerialProfile(profile), state: session?.state ?? "connecting", transportReady: session?.transportReady ?? false, consoleBytes: session?.consoleBytes ?? 0 };
}

export async function serialList(): Promise<any> {
  const profiles = await readSerialProfiles();
  return { content: [{ type: "text", text: profiles.map((profile) => JSON.stringify(publicSerialProfile(profile))).join("\n") || "No serial profiles configured." }], details: { type: "serial", profiles: profiles.map(publicState) } };
}

export async function serialResolve(params: any): Promise<any> {
  const profile = await resolveSerialProfile(params.profile);
  return { content: [{ type: "text", text: JSON.stringify(publicSerialProfile(profile), null, 2) }], details: { type: "serial", ...publicState(profile) } };
}

export async function serialSetCredential(params: any): Promise<any> {
  const profile = await resolveSerialProfile(params.profile);
  if (profile.username !== params.username) throw new Error("credential username 与 profile 不一致");
  await new OsSerialCredentialStore().set(profile.credentialRef, params.username, params.password);
  return { content: [{ type: "text", text: `credential configured: ${profile.id}` }], details: { type: "serial", profile: profile.id, username: params.username, service: SERIAL_CREDENTIAL_SERVICE } };
}

export async function serialExec(params: any, signal?: AbortSignal): Promise<any> {
  const profile = await resolveSerialProfile(params.profile);
  const reason = dangerousReason(params.command);
  if (reason && !params.allowDangerous) throw new Error(`devices_exec 拒绝执行：${reason}`);
  const result = await execProfile(profile, params.command, params.timeout_seconds, signal);
  return { content: [{ type: "text", text: formatResult(result) }], details: { type: "serial", profile: profile.id, command: params.command, exitCode: result.exitCode, timedOut: result.timedOut, durationMs: result.durationMs }, isError: result.exitCode !== 0 || result.timedOut };
}

export async function serialRead(params: any): Promise<any> {
  const profile = await resolveSerialProfile(params.profile);
  const session = await ensureSession(profile);
  if (session.state === "connecting") await new Promise((resolve) => setTimeout(resolve, 1200));
  const count = Math.min(2000, Math.max(1, Math.floor(params.lines ?? 50)));
  const text = session.state === "shell-ready" ? session.output.split("\n").slice(-count).join("\n") : `[serial] ${session.state}${session.transportReady ? " (picocom ready)" : ""}${session.error ? `: ${session.error}` : ""}`;
  return { content: [{ type: "text", text: text || "[serial buffer empty]" }], details: { type: "serial", profile: profile.id, lines: count, state: session.state, transportReady: session.transportReady, consoleBytes: session.consoleBytes } };
}

export default function serialDevicesExtension(pi: ExtensionAPI): void {
  pi.on("system_prompt" as any, ((event: { systemPrompt: string }) => { event.systemPrompt += "\n\n[pi-devices serial] Use explicit serial profiles with direct picocom PTY transport. Credentials are stored in OS secure storage."; }) as any);
  pi.on("session_shutdown", async () => { shutdownSessions(); });
  pi.registerTool({
    name: "devices_set_credential",
    label: "Devices: Set Serial Credential",
    description: "将串口 credential 写入 OS secure storage。",
    parameters: Type.Object({ type: Type.Literal("serial"), profile: Type.String(), username: Type.String(), password: Type.String() }),
    async execute(_id, params: any) { return serialSetCredential(params); },
  });
}
