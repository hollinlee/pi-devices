# @hollinlee/pi-devices

Unified device management extension for Pi coding agent. Manage remote SSH devices and serial consoles through a single interface.

## Installation

```bash
npm install @hollinlee/pi-devices
```

Or install directly from git:

```bash
pi install git:github.com/hollinlee/pi-devices
```

## Configuration

### State Directory

Device configurations and serial profiles are stored in:

```
~/.pi/agent/devices/
├── devices.json       # Remote device registry (Phase 4)
├── profiles.json      # Serial console profiles (Phase 4)
└── bin/               # Compiled probe binaries
    └── remote-probe-<platform>-<arch>
```

### Environment Variables

**Configuration Path:**
- `PI_DEVICES_CONFIG` — Path to unified devices.json (default: `~/.pi/agent/devices/devices.json`)

**Remote Device Tuning:**
- `PI_DEVICES_REMOTE_WRITE_MAX_BYTES` — Maximum content size for remote_write (default: 1048576)
- `PI_DEVICES_REMOTE_BATCH_DEFAULT_MAX_OUTPUT_BYTES` — Per-command output limit for batch operations (default: 4000)
- `PI_DEVICES_REMOTE_BATCH_DEFAULT_TOTAL_OUTPUT_BYTES` — Total output limit for batch operations (default: 32000)
- `PI_DEVICES_REMOTE_BATCH_HARD_MAX_OUTPUT_BYTES` — Hard per-command limit (default: 64000)
- `PI_DEVICES_REMOTE_BATCH_HARD_TOTAL_OUTPUT_BYTES` — Hard total limit (default: 128000)
- `PI_DEVICES_REMOTE_BATCH_MAX_COMMANDS` — Maximum commands per batch (default: 16, max: 64)
- `PI_DEVICES_REMOTE_AUTO_ALIAS_MIN_CONFIDENCE` — Confidence threshold for auto-learning aliases (default: 0.82)
- `PI_DEVICES_REMOTE_AUTO_ALIAS_AMBIGUITY_GAP` — Ambiguity gap for alias resolution (default: 0.08)
- `PI_DEVICES_REMOTE_CONNECT_TIMEOUT_MS` — SSH connection timeout (default: 10000)
- `PI_DEVICES_REMOTE_FIRST_BYTE_TIMEOUT_MS` — First byte timeout (default: 15000)
- `PI_DEVICES_REMOTE_IDLE_TIMEOUT_MS` — Idle timeout (default: 45000)
- `PI_DEVICES_REMOTE_KILL_GRACE_MS` — Grace period before SIGKILL (default: 1500)
- `PI_DEVICES_REMOTE_HEARTBEAT_INTERVAL_MS` — Heartbeat interval (default: 10000)

**Serial Device Configuration:**
- `PI_DEVICES_SERIAL_PROFILES_CONFIG` — Path to profiles.json (overrides PI_DEVICES_CONFIG)
- `PI_DEVICES_SERIAL_CREDENTIAL_SERVICE` — OS keychain service name (default: "pi-devices.serial")
- `PI_DEVICES_REMOTE_PROBE_LEGACY_LINES` — Use legacy one-line probe output when set to `1`

## Migration from oh-my-pi Extensions

If you were using the built-in `remote-devices` or `serial-devices` extensions in oh-my-pi, update your environment variables:

```bash
# Old variables (oh-my-pi extensions)
PI_REMOTE_DEVICES_CONFIG=~/.pi/agent/remote-devices/devices.json
PI_SERIAL_PROFILES_CONFIG=~/.pi/agent/serial-devices/profiles.json
PI_REMOTE_WRITE_MAX_CONTENT_BYTES=2097152

# New variables (@hollinlee/pi-devices)
PI_DEVICES_CONFIG=~/.pi/agent/devices/devices.json
PI_DEVICES_REMOTE_WRITE_MAX_BYTES=2097152
```

Complete variable mapping:

| Old Variable | New Variable |
|--------------|--------------|
| `PI_REMOTE_DEVICES_CONFIG` | `PI_DEVICES_CONFIG` |
| `PI_SERIAL_PROFILES_CONFIG` | `PI_DEVICES_CONFIG` or `PI_DEVICES_SERIAL_PROFILES_CONFIG` |
| `PI_REMOTE_WRITE_MAX_CONTENT_BYTES` | `PI_DEVICES_REMOTE_WRITE_MAX_BYTES` |
| `PI_REMOTE_BATCH_DEFAULT_MAX_OUTPUT_BYTES` | `PI_DEVICES_REMOTE_BATCH_DEFAULT_MAX_OUTPUT_BYTES` |
| `PI_REMOTE_BATCH_DEFAULT_TOTAL_OUTPUT_BYTES` | `PI_DEVICES_REMOTE_BATCH_DEFAULT_TOTAL_OUTPUT_BYTES` |
| `PI_REMOTE_BATCH_HARD_MAX_OUTPUT_BYTES` | `PI_DEVICES_REMOTE_BATCH_HARD_MAX_OUTPUT_BYTES` |
| `PI_REMOTE_BATCH_HARD_TOTAL_OUTPUT_BYTES` | `PI_DEVICES_REMOTE_BATCH_HARD_TOTAL_OUTPUT_BYTES` |
| `PI_REMOTE_BATCH_MAX_COMMANDS` | `PI_DEVICES_REMOTE_BATCH_MAX_COMMANDS` |
| `PI_REMOTE_AUTO_ALIAS_MIN_CONFIDENCE` | `PI_DEVICES_REMOTE_AUTO_ALIAS_MIN_CONFIDENCE` |
| `PI_REMOTE_AUTO_ALIAS_AMBIGUITY_GAP` | `PI_DEVICES_REMOTE_AUTO_ALIAS_AMBIGUITY_GAP` |
| `PI_REMOTE_CONNECT_TIMEOUT_MS` | `PI_DEVICES_REMOTE_CONNECT_TIMEOUT_MS` |
| `PI_REMOTE_FIRST_BYTE_TIMEOUT_MS` | `PI_DEVICES_REMOTE_FIRST_BYTE_TIMEOUT_MS` |
| `PI_REMOTE_IDLE_TIMEOUT_MS` | `PI_DEVICES_REMOTE_IDLE_TIMEOUT_MS` |
| `PI_REMOTE_KILL_GRACE_MS` | `PI_DEVICES_REMOTE_KILL_GRACE_MS` |
| `PI_REMOTE_HEARTBEAT_INTERVAL_MS` | `PI_DEVICES_REMOTE_HEARTBEAT_INTERVAL_MS` |
| `PI_REMOTE_PROBE_LEGACY_LINES` | `PI_DEVICES_REMOTE_PROBE_LEGACY_LINES` |

## Requirements

- Node.js with TypeScript support
- SSH client (`ssh` command) for remote device operations
- `rustc` compiler for building the remote-probe binary
- `picocom` for serial console operations
- Platform-specific credential storage:
  - macOS: Keychain (`security` command)
  - Linux: GNOME Keyring (`secret-tool` command)

## Features (Phase 1)

Phase 1 establishes the repository infrastructure and type system:

- ✅ Package structure and configuration
- ✅ Unified type definitions (RemoteDevice, SerialProfile, etc.)
- ✅ Environment variable constants
- ✅ Extension entry point skeleton

Tool registration and functionality will be added in subsequent phases.

## Development

```bash
# Clone the repository
git clone https://github.com/hollinlee/pi-devices.git
cd pi-devices

# Link for local development
npm link

# In your pi project
npm link @hollinlee/pi-devices
```

## License

MIT © hollinlee
