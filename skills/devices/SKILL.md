---
name: devices
description: Manage configured remote SSH devices and local or SSH-hosted serial consoles through the pi-devices extension. Use when the user mentions SSH, servers, remote machines, serial consoles, UART, picocom, or device profiles.
---

# Devices

Use the unified device tools for configured remote machines and serial consoles. Do not guess device ids, profile ids, ports, credentials, or passwords.

## Tool Selection

Use `devices_list` to inspect configured devices or serial profiles:

```json
{"type":"remote"}
{"type":"serial"}
```

For a natural-language remote machine name, call `devices_resolve` first:

```json
{"type":"remote","query":"lab pc"}
```

When the match is unique and confidence is acceptable, use the resolved id with `devices_exec`, `devices_read`, or another remote-only tool. If multiple devices match or confidence is low, ask the user to choose. A confident fuzzy match may be saved as an alias automatically; use `devices_learn_alias` when the user explicitly clarifies a nickname.

For serial, always use an explicit profile id. First call `devices_list` with `type: "serial"`, then resolve a selected id with `devices_resolve` using `{"type":"serial","profile":"<profile-id>"}`. Pass that explicit `profile` to `devices_read`, `devices_exec`, or `devices_set_credential`.

## Remote SSH

- `devices_exec` with `type: "remote"` runs one non-interactive SSH command.
- `devices_read` with `type: "remote"` reads remote text files with offset/limit, or supported images as attachments. Prefer it over `devices_exec` with `cat`.
- `devices_write` writes remote text as data. Prefer it over heredocs through `devices_exec`.
- `devices_exec_batch` runs multiple commands through one SSH call. Use `mode: "parallel"` for independent lightweight read-only probes and `mode: "sequential"` when commands depend on each other or share mutable resources.
- `devices_probe` checks all configured remote devices concurrently and reports route, check, and endpoint status.
- `devices_test_connection` is for an explicit connectivity test, after adding/changing a device, or diagnosing a failed remote operation. Do not use it as a routine preflight before `devices_exec`.
- `devices_add_device` adds or updates a configured device. After changing a device, use `devices_test_connection` to validate it.
- `devices_install_keys` installs trusted public keys for selected remote users.

Use configured devices instead of ad-hoc `ssh` in bash. SSH uses key authentication and non-interactive mode; it must not prompt for passwords.

Every remote-only tool also requires `type: "remote"`. For example, use `devices_exec_batch` with:

```json
{
  "type": "remote",
  "device": "lab-machine",
  "mode": "parallel",
  "commands": [
    { "id": "disk", "command": "df -hT" },
    { "id": "memory", "command": "free -h" },
    { "id": "uptime", "command": "uptime" }
  ],
  "timeout_seconds": 30
}
```

`devices_probe` de-duplicates entries by `host:port`, preferring an `ssh-config` route, then `root`, then the first remaining entry. All devices are checked directly by a non-interactive SSH login running `true`; ICMP, TCP preflight, and Tailscale ping are not used. `ssh-config` devices use the configured OpenSSH alias.

When adding a device, collect a stable id, host/IP, default SSH user, port if not 22, and optional aliases/tags. If key login is unavailable, use temporary bootstrap credentials outside persistent config before installing public keys.

For `devices_install_keys`, `keySources` can contain `local-default` (`~/.ssh/id_ed25519.pub`) and `local-authorized-keys` (keys trusted in local `~/.ssh/authorized_keys`). Provide `targetUsers`; connect as `root` when available if installing keys for root. Keys are de-duplicated by key type and key blob.

To persist a clarified nickname, call `devices_learn_alias` with `{"type":"remote","device":"<chosen-id>","alias":"<original nickname>"}`.

## Remote Timeouts and Output

Set `timeout_seconds` explicitly based on expected command duration. These are total command budgets; low-level SSH connect, first-byte, idle, heartbeat, and kill-grace watchdogs remain active.

- Quick probes (`whoami`, `hostname`, `uptime`, `pwd`, `ls`, `df -h`): 10-30s.
- Status and small log reads: 30-90s.
- Package/service diagnostics or moderate file operations: 60-180s.
- Downloads, package updates, or container pulls: 300-900s.
- Builds, full test suites, image builds, or large scans: 600-1800s.

For batch operations, set `max_output_bytes` and `total_max_output_bytes` to the expected answer size. Reduce output at source with `head`, `tail`, `grep`, `jq`, or `journalctl -n`. Do not use huge budgets to hide uncertainty. Treat `idle-timeout` as a stuck/lost connection signal and `total-timeout` as an under-sized command budget.

Budget a parallel batch for its slowest command plus SSH overhead; budget a sequential batch for cumulative runtime. Tool hard output caps still apply. Unstable device links may need conservative 120-300s diagnostic budgets. Long commands return their output and diagnostics in the final tool result; heartbeat and bounded capture remain active.

## Remote Safety

- Read-only commands such as `whoami`, `hostname`, `uptime`, `df -h`, `free -h`, status checks, and bounded log reads are fine.
- Package installs, service configuration, firewall/SSH changes, database mutations, and destructive actions require clear user authorization.
- `devices_exec` and `devices_exec_batch` block common destructive commands unless `allowDangerous: true`; set it only after explicit authorization for that exact action.
- Use `sudo: true` only when necessary. It uses `sudo -n` and fails instead of prompting.
- Avoid parallel batches for package managers, service changes, writes, or commands competing for the same resource/lock.
- `devices_write` treats content as data, but sensitive target paths still require explicit authorization and `allowDangerous: true` where applicable.
- Never store passwords in `PI_DEVICES_CONFIG` or any profile/config file. Passwords are temporary bootstrap credentials only.
- Diagnose structured `errorKind` values such as `connect-timeout`, `idle-timeout`, `remote-disconnected`, `sudo-password-required`, or `interactive-prompt-detected`; do not retry blindly.

## Serial Consoles

Serial profiles are stored in the unified `PI_DEVICES_CONFIG` file. The serial credential service is `pi-devices.serial`; use `devices_set_credential` to store credentials in OS secure storage. Never put passwords in profile JSON, shell commands, other tool arguments, results, or logs. The login username comes from the profile and must match the credential username.

- `devices_set_credential` with `type: "serial"` stores the username/password for an explicit profile.
- `devices_read` with `type: "serial"` reads the bounded session buffer and status.
- `devices_exec` with `type: "serial"` runs a shell command only after login and shell readiness are confirmed.

Serial transport may be local or remote. Local transport uses `node-pty` and `picocom`; remote transport uses SSH with an interactive PTY to run `picocom` on the host that owns the serial device. The remote route comes from the configured remote device. The host must have `picocom`, and the SSH user must have permission to access the serial port.

The serial session is stateful within the current Pi process. It detects `connecting`, `login-required`, `authenticating`, `shell-ready`, `bootloader`, and `stale` states. Commands for one profile are serialized with a per-profile lock. A timeout, cancellation, or transport loss makes the session stale; commands are not replayed automatically.

Before a shell is confirmed:

- Use `devices_read` to inspect status; do not execute commands.
- Do not guess a username or password.
- Do not expose pre-login console output.
- Do not execute commands in bootloader state.

`devices_read` before shell confirmation returns status without sending commands or logging in. `devices_exec` prepares login using stored credentials and verifies the shell before executing the requested command; missing credentials are not a reason to guess passwords.

After shell confirmation, serial commands use a completion marker to return stdout and exit code. Dangerous commands such as `reboot`, `shutdown`, `poweroff`, `halt`, `mkfs`, `dd`, and recursive/forced `rm` require explicit `allowDangerous: true` authorization.

Do not use tmux. On WSL2, if `/dev/ttyUSB*` or `/dev/serial/by-id/*` is missing, attach the USB device from Windows with `usbipd attach --wsl --busid <BUSID>` before retrying. Reboots or USB reconnection may require another attach.

## Configuration

The unified config path is controlled by `PI_DEVICES_CONFIG`; the default is `~/.pi/agent/devices/devices.json`. It contains remote `devices` and serial `profiles`. Back up existing remote and serial config files before a manual merge. Verify the merged config before removing old files.

The package does not bundle real devices. Use `devices_list` for the authoritative runtime inventory.
