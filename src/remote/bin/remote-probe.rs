use std::collections::{BTreeMap, VecDeque};
use std::env;
use std::fs;
use std::io::{self, Write};
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::{mpsc, Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

#[derive(Clone, Debug)]
struct SshRoute {
    kind: String,
    target: Option<String>,
    label: Option<String>,
    user: Option<String>,
    identity_file: Option<String>,
}

#[derive(Clone, Debug)]
struct Device {
    id: String,
    host: String,
    port: u16,
    user: String,
    identity_file: Option<String>,
    ssh_route: Option<SshRoute>,
}

#[derive(Clone, Debug)]
struct ProbeOptions {
    config: PathBuf,
    timeout: Duration,
    ssh_timeout: Duration,
    concurrency: usize,
    color: bool,
}

#[derive(Debug)]
struct ProbeResult {
    index: usize,
    id: String,
    host: String,
    port: u16,
    ok: bool,
    route: String,
    endpoint: String,
    ssh_ms: Option<u128>,
    ssh_error: Option<String>,
}

#[allow(dead_code)]
#[derive(Clone, Debug)]
enum Json {
    Null,
    Bool(bool),
    Number(f64),
    String(String),
    Array(Vec<Json>),
    Object(BTreeMap<String, Json>),
}

struct JsonParser<'a> {
    src: &'a [u8],
    pos: usize,
}

impl<'a> JsonParser<'a> {
    fn new(src: &'a str) -> Self {
        Self { src: src.as_bytes(), pos: 0 }
    }

    fn parse(mut self) -> Result<Json, String> {
        let value = self.parse_value()?;
        self.skip_ws();
        if self.pos != self.src.len() {
            return Err(format!("unexpected trailing data at byte {}", self.pos));
        }
        Ok(value)
    }

    fn parse_value(&mut self) -> Result<Json, String> {
        self.skip_ws();
        match self.peek() {
            Some(b'n') => self.parse_literal(b"null", Json::Null),
            Some(b't') => self.parse_literal(b"true", Json::Bool(true)),
            Some(b'f') => self.parse_literal(b"false", Json::Bool(false)),
            Some(b'\"') => self.parse_string().map(Json::String),
            Some(b'[') => self.parse_array(),
            Some(b'{') => self.parse_object(),
            Some(b'-') | Some(b'0'..=b'9') => self.parse_number().map(Json::Number),
            Some(c) => Err(format!("unexpected byte '{}' at {}", c as char, self.pos)),
            None => Err("unexpected end of input".to_string()),
        }
    }

    fn parse_literal(&mut self, literal: &[u8], value: Json) -> Result<Json, String> {
        if self.src.get(self.pos..self.pos + literal.len()) == Some(literal) {
            self.pos += literal.len();
            Ok(value)
        } else {
            Err(format!("expected literal at byte {}", self.pos))
        }
    }

    fn parse_string(&mut self) -> Result<String, String> {
        self.expect(b'\"')?;
        let mut out = String::new();
        while let Some(c) = self.next() {
            match c {
                b'\"' => return Ok(out),
                b'\\' => {
                    let esc = self.next().ok_or_else(|| "unterminated escape".to_string())?;
                    match esc {
                        b'\"' => out.push('\"'),
                        b'\\' => out.push('\\'),
                        b'/' => out.push('/'),
                        b'b' => out.push('\u{0008}'),
                        b'f' => out.push('\u{000c}'),
                        b'n' => out.push('\n'),
                        b'r' => out.push('\r'),
                        b't' => out.push('\t'),
                        b'u' => {
                            let code = self.parse_hex4()?;
                            if (0xD800..=0xDBFF).contains(&code) {
                                let save = self.pos;
                                if self.next() == Some(b'\\') && self.next() == Some(b'u') {
                                    let low = self.parse_hex4()?;
                                    if (0xDC00..=0xDFFF).contains(&low) {
                                        let scalar = 0x10000 + (((code - 0xD800) as u32) << 10) + ((low - 0xDC00) as u32);
                                        if let Some(ch) = char::from_u32(scalar) {
                                            out.push(ch);
                                        }
                                    } else {
                                        return Err("invalid unicode surrogate pair".to_string());
                                    }
                                } else {
                                    self.pos = save;
                                    return Err("missing low unicode surrogate".to_string());
                                }
                            } else if let Some(ch) = char::from_u32(code as u32) {
                                out.push(ch);
                            } else {
                                return Err("invalid unicode codepoint".to_string());
                            }
                        }
                        _ => return Err(format!("invalid escape at byte {}", self.pos)),
                    }
                }
                0x00..=0x1F => return Err("control character in string".to_string()),
                _ => {
                    let start = self.pos - 1;
                    if c < 0x80 {
                        out.push(c as char);
                    } else {
                        let mut end = self.pos;
                        while end < self.src.len() && (self.src[end] & 0b1100_0000) == 0b1000_0000 {
                            end += 1;
                        }
                        let s = std::str::from_utf8(&self.src[start..end]).map_err(|e| e.to_string())?;
                        out.push_str(s);
                        self.pos = end;
                    }
                }
            }
        }
        Err("unterminated string".to_string())
    }

    fn parse_hex4(&mut self) -> Result<u16, String> {
        if self.pos + 4 > self.src.len() {
            return Err("short unicode escape".to_string());
        }
        let mut value: u16 = 0;
        for _ in 0..4 {
            let c = self.next().unwrap();
            let digit = match c {
                b'0'..=b'9' => c - b'0',
                b'a'..=b'f' => c - b'a' + 10,
                b'A'..=b'F' => c - b'A' + 10,
                _ => return Err("invalid unicode escape".to_string()),
            };
            value = (value << 4) | digit as u16;
        }
        Ok(value)
    }

    fn parse_array(&mut self) -> Result<Json, String> {
        self.expect(b'[')?;
        let mut items = Vec::new();
        loop {
            self.skip_ws();
            if self.consume(b']') {
                break;
            }
            items.push(self.parse_value()?);
            self.skip_ws();
            if self.consume(b']') {
                break;
            }
            self.expect(b',')?;
        }
        Ok(Json::Array(items))
    }

    fn parse_object(&mut self) -> Result<Json, String> {
        self.expect(b'{')?;
        let mut map = BTreeMap::new();
        loop {
            self.skip_ws();
            if self.consume(b'}') {
                break;
            }
            let key = self.parse_string()?;
            self.skip_ws();
            self.expect(b':')?;
            let value = self.parse_value()?;
            map.insert(key, value);
            self.skip_ws();
            if self.consume(b'}') {
                break;
            }
            self.expect(b',')?;
        }
        Ok(Json::Object(map))
    }

    fn parse_number(&mut self) -> Result<f64, String> {
        let start = self.pos;
        self.consume(b'-');
        match self.peek() {
            Some(b'0') => { self.pos += 1; }
            Some(b'1'..=b'9') => while matches!(self.peek(), Some(b'0'..=b'9')) { self.pos += 1; },
            _ => return Err(format!("invalid number at byte {}", start)),
        }
        if self.consume(b'.') {
            let before = self.pos;
            while matches!(self.peek(), Some(b'0'..=b'9')) { self.pos += 1; }
            if self.pos == before { return Err("invalid fraction".to_string()); }
        }
        if matches!(self.peek(), Some(b'e' | b'E')) {
            self.pos += 1;
            if matches!(self.peek(), Some(b'+' | b'-')) { self.pos += 1; }
            let before = self.pos;
            while matches!(self.peek(), Some(b'0'..=b'9')) { self.pos += 1; }
            if self.pos == before { return Err("invalid exponent".to_string()); }
        }
        let s = std::str::from_utf8(&self.src[start..self.pos]).map_err(|e| e.to_string())?;
        s.parse::<f64>().map_err(|e| e.to_string())
    }

    fn skip_ws(&mut self) {
        while matches!(self.peek(), Some(b' ' | b'\n' | b'\r' | b'\t')) {
            self.pos += 1;
        }
    }

    fn expect(&mut self, byte: u8) -> Result<(), String> {
        if self.consume(byte) { Ok(()) } else { Err(format!("expected '{}' at byte {}", byte as char, self.pos)) }
    }

    fn consume(&mut self, byte: u8) -> bool {
        if self.peek() == Some(byte) {
            self.pos += 1;
            true
        } else {
            false
        }
    }

    fn peek(&self) -> Option<u8> {
        self.src.get(self.pos).copied()
    }

    fn next(&mut self) -> Option<u8> {
        let c = self.peek()?;
        self.pos += 1;
        Some(c)
    }
}

fn json_obj<'a>(value: &'a Json) -> Option<&'a BTreeMap<String, Json>> {
    if let Json::Object(map) = value { Some(map) } else { None }
}

fn json_array<'a>(value: &'a Json) -> Option<&'a Vec<Json>> {
    if let Json::Array(items) = value { Some(items) } else { None }
}

fn json_str<'a>(map: &'a BTreeMap<String, Json>, key: &str) -> Option<&'a str> {
    match map.get(key) {
        Some(Json::String(s)) => Some(s),
        _ => None,
    }
}

fn json_u16(map: &BTreeMap<String, Json>, key: &str) -> Option<u16> {
    match map.get(key) {
        Some(Json::Number(n)) if *n >= 0.0 && *n <= u16::MAX as f64 => Some(*n as u16),
        _ => None,
    }
}

fn probe_user_rank(user: &str) -> u8 {
    if user == "root" { 0 } else { 1 }
}

fn probe_device_rank(device: &Device) -> i16 {
    let route_bonus = match &device.ssh_route {
        Some(route) if route.kind == "ssh-config" => -10,
        _ => 0,
    };
    route_bonus + probe_user_rank(&device.user) as i16
}

fn prefer_probe_device(candidate: &Device, current: &Device) -> bool {
    probe_device_rank(candidate) < probe_device_rank(current)
}

fn select_probe_devices(devices: Vec<Device>) -> Vec<Device> {
    let mut selected: Vec<Device> = Vec::new();
    for device in devices {
        if let Some(existing) = selected.iter_mut().find(|item| item.host == device.host && item.port == device.port) {
            if prefer_probe_device(&device, existing) {
                *existing = device;
            }
        } else {
            selected.push(device);
        }
    }
    selected
}

fn load_devices(path: &PathBuf) -> Result<Vec<Device>, String> {
    let raw = fs::read_to_string(path).map_err(|e| format!("读取配置失败: {e}"))?;
    let root = JsonParser::new(&raw).parse().map_err(|e| format!("解析配置失败: {e}"))?;
    let root_obj = json_obj(&root).ok_or_else(|| "配置根节点不是 object".to_string())?;
    let arr = root_obj.get("devices").and_then(json_array).ok_or_else(|| "配置缺少 devices 数组".to_string())?;
    let mut devices = Vec::new();
    for item in arr {
        let Some(obj) = json_obj(item) else { continue; };
        let Some(id) = json_str(obj, "id") else { continue; };
        let Some(host) = json_str(obj, "host") else { continue; };
        let Some(user) = json_str(obj, "defaultUser") else { continue; };
        let port = json_u16(obj, "port").unwrap_or(22);
        let identity_file = obj
            .get("auth")
            .and_then(json_obj)
            .and_then(|auth| json_str(auth, "identityFile"))
            .map(|s| s.to_string());
        let ssh_route = obj.get("sshRoute").and_then(json_obj).map(|route| SshRoute {
            kind: json_str(route, "type").unwrap_or("direct").to_string(),
            target: json_str(route, "target").or_else(|| json_str(route, "sshHost")).map(|s| s.to_string()),
            label: json_str(route, "label").map(|s| s.to_string()),
            user: json_str(route, "user").map(|s| s.to_string()),
            identity_file: json_str(route, "identityFile").map(|s| s.to_string()),
        });
        devices.push(Device { id: id.to_string(), host: host.to_string(), port, user: user.to_string(), identity_file, ssh_route });
    }
    Ok(select_probe_devices(devices))
}

fn expand_home(value: &str) -> String {
    if value == "~" {
        return env::var("HOME").unwrap_or_else(|_| value.to_string());
    }
    if let Some(rest) = value.strip_prefix("~/") {
        if let Ok(home) = env::var("HOME") {
            return format!("{home}/{rest}");
        }
    }
    value.to_string()
}

fn route_target(device: &Device) -> Option<String> {
    let route = device.ssh_route.as_ref()?;
    if route.kind != "ssh-config" {
        return None;
    }
    route.target.clone()
}

fn route_label(device: &Device) -> String {
    if let Some(route) = &device.ssh_route {
        if route.kind == "ssh-config" {
            let label = route.label.clone().or_else(|| route.target.clone()).unwrap_or_else(|| "ssh-config".to_string());
            return format!("via {label}");
        }
    }
    "direct".to_string()
}

fn endpoint_label(device: &Device) -> String {
    if let Some(target) = route_target(device) {
        return target;
    }
    format!("{}:{}", device.host, device.port)
}

fn ssh_check(device: &Device, timeout: Duration) -> Result<u128, String> {
    let start = Instant::now();
    let mut cmd = Command::new("ssh");
    let connect_secs = std::cmp::max(1, ((timeout.as_millis() + 999) / 1000) as u64);
    cmd.arg("-o").arg("BatchMode=yes")
        .arg("-o").arg("NumberOfPasswordPrompts=0")
        .arg("-o").arg("StrictHostKeyChecking=accept-new")
        .arg("-o").arg(format!("ConnectTimeout={connect_secs}"))
        .arg("-o").arg("ServerAliveInterval=2")
        .arg("-o").arg("ServerAliveCountMax=1");
    if let Some(route) = &device.ssh_route {
        if let Some(identity) = &route.identity_file {
            cmd.arg("-i").arg(expand_home(identity));
        } else if let Some(identity) = &device.identity_file {
            cmd.arg("-i").arg(expand_home(identity));
        }
        if route.kind == "ssh-config" {
            let target = route.target.clone().ok_or_else(|| "SSH route target missing".to_string())?;
            let user = route.user.as_ref().unwrap_or(&device.user);
            cmd.arg("-l").arg(user).arg(target).arg("true");
            cmd.stdout(Stdio::null()).stderr(Stdio::piped());
            return wait_ssh(cmd, start, timeout);
        }
    }
    cmd.arg("-p").arg(device.port.to_string());
    if let Some(identity) = &device.identity_file {
        cmd.arg("-i").arg(expand_home(identity));
    }
    cmd.arg(format!("{}@{}", device.user, device.host)).arg("true");
    cmd.stdout(Stdio::null()).stderr(Stdio::piped());
    wait_ssh(cmd, start, timeout)
}

fn wait_ssh(mut cmd: Command, start: Instant, timeout: Duration) -> Result<u128, String> {

    let mut child = cmd.spawn().map_err(|_| "SSH command unavailable".to_string())?;
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                let elapsed = start.elapsed().as_millis();
                let mut stderr = String::new();
                if let Some(mut pipe) = child.stderr.take() {
                    use std::io::Read;
                    let _ = pipe.read_to_string(&mut stderr);
                }
                if status.success() {
                    return Ok(elapsed);
                }
                return Err(classify_ssh_error(&stderr));
            }
            Ok(None) => {
                if start.elapsed() >= timeout {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err("SSH connect timeout".to_string());
                }
                thread::sleep(Duration::from_millis(50));
            }
            Err(_) => {
                let _ = child.kill();
                return Err("SSH login failed".to_string());
            }
        }
    }
}

fn classify_ssh_error(stderr: &str) -> String {
    let s = stderr.to_lowercase();
    if s.contains("permission denied") || s.contains("publickey") {
        "SSH auth failed".to_string()
    } else if s.contains("host key verification failed") || s.contains("remote host identification has changed") {
        "host key mismatch".to_string()
    } else if s.contains("connection timed out") || s.contains("operation timed out") {
        "SSH connect timeout".to_string()
    } else if s.contains("connection refused") {
        "SSH port refused".to_string()
    } else if s.contains("no route to host") || s.contains("network is unreachable") {
        "network unreachable".to_string()
    } else if s.contains("could not resolve hostname") || s.contains("name or service not known") {
        "DNS resolution failed".to_string()
    } else if s.contains("too many authentication failures") {
        "SSH auth failed".to_string()
    } else {
        "SSH login failed".to_string()
    }
}

fn probe_device(index: usize, device: Device, options: &ProbeOptions) -> ProbeResult {
    let mut result = ProbeResult {
        index,
        id: device.id.clone(),
        host: device.host.clone(),
        port: device.port,
        ok: false,
        route: route_label(&device),
        endpoint: endpoint_label(&device),
        ssh_ms: None,
        ssh_error: None,
    };

    match ssh_check(&device, options.ssh_timeout) {
        Ok(ms) => {
            result.ok = true;
            result.ssh_ms = Some(ms);
        }
        Err(e) => result.ssh_error = Some(e),
    }
    result
}

fn parse_args() -> Result<ProbeOptions, String> {
    let mut config = env::var("PI_DEVICES_CONFIG")
        .map(PathBuf::from)
        .unwrap_or_else(|_| {
            let home = env::var("HOME").unwrap_or_else(|_| ".".to_string());
            PathBuf::from(home).join(".pi/agent/devices/devices.json")
        });
    let mut timeout = Duration::from_millis(1500);
    let mut ssh_timeout = Duration::from_millis(3500);
    let mut concurrency = 64usize;
    let mut color = true;

    let args: Vec<String> = env::args().skip(1).collect();
    let mut i = 0;
    while i < args.len() {
        match args[i].as_str() {
            "--config" => {
                i += 1;
                config = PathBuf::from(args.get(i).ok_or_else(|| "--config 缺少路径".to_string())?);
            }
            "--timeout-ms" => {
                i += 1;
                let ms = args.get(i).ok_or_else(|| "--timeout-ms 缺少数值".to_string())?.parse::<u64>().map_err(|_| "--timeout-ms 不是数字".to_string())?;
                timeout = Duration::from_millis(ms);
            }
            "--ssh-timeout-ms" => {
                i += 1;
                let ms = args.get(i).ok_or_else(|| "--ssh-timeout-ms 缺少数值".to_string())?.parse::<u64>().map_err(|_| "--ssh-timeout-ms 不是数字".to_string())?;
                ssh_timeout = Duration::from_millis(ms);
            }
            "--concurrency" => {
                i += 1;
                concurrency = args.get(i).ok_or_else(|| "--concurrency 缺少数值".to_string())?.parse::<usize>().map_err(|_| "--concurrency 不是数字".to_string())?.max(1);
            }
            "--no-color" => color = false,
            "--help" | "-h" => {
                println!("Usage: remote-probe --config <devices.json> [--timeout-ms 1500] [--ssh-timeout-ms 3500] [--concurrency 64] [--no-color]");
                std::process::exit(0);
            }
            other => return Err(format!("未知参数: {other}")),
        }
        i += 1;
    }
    Ok(ProbeOptions { config, timeout, ssh_timeout, concurrency, color })
}

fn colorize(enabled: bool, color: &str, text: &str) -> String {
    if enabled { format!("\x1b[{color}m{text}\x1b[0m") } else { text.to_string() }
}

fn warning_label(enabled: bool) -> String {
    colorize(enabled, "38;5;100", "warning")
}

struct ProbeGroup {
    index: usize,
    results: Vec<ProbeResult>,
}

fn group_label(group: &ProbeGroup) -> String {
    group.results[0].id.clone()
}

fn metric_text(ms: Option<u128>, error: Option<&String>) -> String {
    if let Some(ms) = ms {
        return format!("{ms}ms");
    }
    match error.map(|s| s.as_str()) {
        Some("ping unavailable") => "n/a".to_string(),
        Some("ping failed") => "failed".to_string(),
        Some(value) => value.to_string(),
        None => "-".to_string(),
    }
}

fn manageability_text(result: &ProbeResult) -> String {
    if result.ok {
        return metric_text(result.ssh_ms, result.ssh_error.as_ref());
    }
    legacy_failure_message(result)
}

fn group_columns(group: &ProbeGroup) -> (String, String, String) {
    let first = &group.results[0];
    (first.route.clone(), manageability_text(first), first.endpoint.clone())
}

fn print_results(mut results: Vec<ProbeResult>, color: bool) {
    results.sort_by_key(|r| r.index);

    if env::var("PI_DEVICES_REMOTE_PROBE_LEGACY_LINES").ok().as_deref() == Some("1") {
        print_legacy_results(results, color);
        return;
    }

    let mut groups: Vec<ProbeGroup> = Vec::new();
    let mut group_index_by_host_port: BTreeMap<String, usize> = BTreeMap::new();
    for r in results {
        let key = format!("{}:{}", r.host, r.port);
        if let Some(group_index) = group_index_by_host_port.get(&key).copied() {
            groups[group_index].results.push(r);
        } else {
            let group_index = groups.len();
            group_index_by_host_port.insert(key, group_index);
            groups.push(ProbeGroup { index: r.index, results: vec![r] });
        }
    }
    groups.sort_by_key(|g| (if g.results.iter().all(|r| r.ok) { 0 } else { 1 }, g.index));

    let rows = groups.iter().map(|group| {
        let label = group_label(group);
        let ok = group.results.iter().all(|r| r.ok);
        let (route, check, endpoint) = group_columns(group);
        (ok, label, route, check, endpoint)
    }).collect::<Vec<_>>();

    let device_width = rows.iter().map(|(_, label, _, _, _)| label.chars().count()).max().unwrap_or(6).max("DEVICE".len());
    let route_width = rows.iter().map(|(_, _, route, _, _)| route.chars().count()).max().unwrap_or(5).max("ROUTE".len());
    let check_width = rows.iter().map(|(_, _, _, check, _)| check.chars().count()).max().unwrap_or(5).max("CHECK".len());

    println!("S  {device:<device_width$}  {route:<route_width$}  {check:<check_width$}  ENDPOINT",
        device = "DEVICE", route = "ROUTE", check = "CHECK",
        device_width = device_width, route_width = route_width, check_width = check_width);
    for (ok, label, route, check, endpoint) in &rows {
        let mark = if *ok { colorize(color, "32", "✓") } else { colorize(color, "31", "×") };
        println!("{mark}  {label:<device_width$}  {route:<route_width$}  {check:<check_width$}  {endpoint}",
            device_width = device_width, route_width = route_width, check_width = check_width);
    }

    let ok = groups.iter().flat_map(|g| &g.results).filter(|r| r.ok).count();
    let total = groups.iter().map(|g| g.results.len()).sum::<usize>();
    let group_total = groups.len();
    let summary = if ok == total {
        format!("OK all {ok}/{total} devices · {group_total} hosts")
    } else {
        format!("{} OK {ok}/{total} devices · {group_total} hosts", warning_label(color))
    };
    println!("{summary}");
}

fn legacy_failure_message(result: &ProbeResult) -> String {
    result.ssh_error
        .as_ref()
        .cloned()
        .unwrap_or_else(|| "unknown failure".to_string())
}

fn print_legacy_results(results: Vec<ProbeResult>, color: bool) {
    let mut groups: Vec<ProbeGroup> = Vec::new();
    let mut group_index_by_host_port: BTreeMap<String, usize> = BTreeMap::new();
    for r in results {
        let key = format!("{}:{}", r.host, r.port);
        if let Some(group_index) = group_index_by_host_port.get(&key).copied() {
            groups[group_index].results.push(r);
        } else {
            let group_index = groups.len();
            group_index_by_host_port.insert(key, group_index);
            groups.push(ProbeGroup { index: r.index, results: vec![r] });
        }
    }
    groups.sort_by_key(|g| (if g.results.iter().all(|r| r.ok) { 0 } else { 1 }, g.index));

    let width = groups.iter().map(|g| group_label(g).chars().count()).max().unwrap_or(2).max(2);
    for group in &groups {
        let label = group_label(group);
        let ok = group.results.iter().all(|r| r.ok);
        let mark = if ok { colorize(color, "32", "✓") } else { colorize(color, "31", "×") };
        let r = &group.results[0];
        let message = if r.ok { metric_text(r.ssh_ms, r.ssh_error.as_ref()) } else { legacy_failure_message(r) };
        println!("{mark} {label:width$} {message}", width = width);
    }

    let ok = groups.iter().flat_map(|g| &g.results).filter(|r| r.ok).count();
    let total = groups.iter().map(|g| g.results.len()).sum::<usize>();
    let group_total = groups.len();
    let summary = if ok == total {
        format!("OK all {ok}/{total} devices · {group_total} hosts")
    } else {
        format!("{} OK {ok}/{total} devices · {group_total} hosts", warning_label(color))
    };
    println!("{summary}");
}

fn run() -> Result<i32, String> {
    let options = parse_args()?;
    let devices = load_devices(&options.config)?;
    if devices.is_empty() {
        println!("No remote devices configured.");
        return Ok(0);
    }

    let queue: Arc<Mutex<VecDeque<(usize, Device)>>> = Arc::new(Mutex::new(devices.into_iter().enumerate().collect()));
    let (tx, rx) = mpsc::channel();
    let workers = options.concurrency.min(queue.lock().unwrap().len()).max(1);

    for _ in 0..workers {
        let queue = Arc::clone(&queue);
        let tx = tx.clone();
        let options = options.clone();
        thread::spawn(move || loop {
            let next = queue.lock().unwrap().pop_front();
            let Some((index, device)) = next else { break; };
            let result = probe_device(index, device, &options);
            if tx.send(result).is_err() { break; }
        });
    }
    drop(tx);

    let results: Vec<_> = rx.into_iter().collect();
    let any_failed = results.iter().any(|r| !r.ok);
    print_results(results, options.color);
    Ok(if any_failed { 2 } else { 0 })
}

fn main() {
    match run() {
        Ok(code) => std::process::exit(code),
        Err(e) => {
            let _ = writeln!(io::stderr(), "remote-probe: {e}");
            std::process::exit(1);
        }
    }
}
