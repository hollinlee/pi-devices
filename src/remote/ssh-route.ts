import { homedir } from "node:os";
import { join } from "node:path";
import type { RemoteDevice } from "../types.ts";

type SshRouteOptions = { interactive?: boolean };

function expandHome(value: string): string {
  if (value === "~") return homedir();
  return value.startsWith("~/") ? join(homedir(), value.slice(2)) : value;
}

export function resolveSshRouteArgs(
  device: RemoteDevice,
  command: string,
  options: SshRouteOptions = {},
): string[] {
  const route = device.sshRoute?.type === "ssh-config" ? device.sshRoute : undefined;
  const target = route?.target || route?.sshHost || device.host;
  const user = route?.user || device.defaultUser;
  if (!target || !user) throw new Error(`remote device has no SSH target/user: ${device.id}`);

  const args = [
    ...(options.interactive ? ["-tt"] : []),
    "-o", "BatchMode=yes",
    "-o", "NumberOfPasswordPrompts=0",
    "-o", "StrictHostKeyChecking=accept-new",
    "-o", "ConnectTimeout=10",
  ];
  if (!route) {
    const port = device.port ?? 22;
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error(`remote device has invalid SSH port: ${device.id}`);
    }
    args.push("-p", String(port));
  }
  const identityFile = route?.identityFile || device.auth?.identityFile;
  if (identityFile) args.push("-i", expandHome(identityFile));
  args.push("-l", user, target, command);
  return args;
}
