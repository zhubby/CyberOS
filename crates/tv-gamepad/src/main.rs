use std::collections::{HashMap, HashSet};
use std::env;
use std::ffi::OsStr;
use std::io;
use std::path::{Path, PathBuf};
use std::process::ExitCode;
use std::time::{Duration, Instant};

use evdev::{Device, EventSummary};
use tokio::process::Command;
use tokio::sync::mpsc;
use tokio::task::JoinHandle;
use tokio::time::{MissedTickBehavior, interval, timeout};
use tracing_subscriber::EnvFilter;
use zos_tv_gamepad::{
    AxisRange, CapabilityDescriptor, Health, InputEvent, InputHub, code, evaluate_health,
};

const SCAN_INTERVAL: Duration = Duration::from_secs(1);
const REPEAT_TICK: Duration = Duration::from_millis(20);
const HEARTBEAT_INTERVAL: Duration = Duration::from_secs(5);
const WTYPE_TIMEOUT: Duration = Duration::from_secs(2);
const EVENT_QUEUE_CAPACITY: usize = 256;

#[derive(Debug)]
struct ActiveDevice {
    generation: u64,
    task: JoinHandle<()>,
}

#[derive(Debug)]
enum ReaderMessage {
    Event {
        path: PathBuf,
        generation: u64,
        event: InputEvent,
    },
    Disconnected {
        path: PathBuf,
        generation: u64,
        detail: String,
    },
}

#[tokio::main]
async fn main() -> ExitCode {
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")),
        )
        .with_target(false)
        .init();

    if env::args_os().nth(1).is_some() {
        tracing::error!("usage: zos-tv-gamepad");
        return ExitCode::from(64);
    }
    match run().await {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            tracing::error!(message = %error, "TV gamepad service stopped");
            ExitCode::FAILURE
        }
    }
}

async fn run() -> io::Result<()> {
    let input_dir = env::var_os("ZOS_TV_INPUT_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("/dev/input"));
    let status_writer = env::var_os("ZOS_TV_STATUS_WRITER")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("/usr/lib/zos/scripts/zos-tv-write-status"));
    let wtype = env::var_os("ZOS_TV_WTYPE")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("wtype"));
    let started = Instant::now();
    let (sender, mut receiver) = mpsc::channel(EVENT_QUEUE_CAPACITY);
    let mut active = HashMap::<PathBuf, ActiveDevice>::new();
    let mut hub = InputHub::default();
    let mut generation = 0_u64;
    let mut input_error = None;
    let mut injection_error = None;
    let mut scan_timer = interval(SCAN_INTERVAL);
    let mut repeat_timer = interval(REPEAT_TICK);
    let mut heartbeat_timer = interval(HEARTBEAT_INTERVAL);
    scan_timer.set_missed_tick_behavior(MissedTickBehavior::Skip);
    repeat_timer.set_missed_tick_behavior(MissedTickBehavior::Skip);
    heartbeat_timer.set_missed_tick_behavior(MissedTickBehavior::Skip);

    loop {
        tokio::select! {
            _ = scan_timer.tick() => {
                input_error = scan_devices(
                    &input_dir,
                    &mut active,
                    &mut hub,
                    &mut generation,
                    &sender,
                );
            }
            _ = repeat_timer.tick() => {
                for key in hub.repeat(started.elapsed()) {
                    injection_error = inject_key(&wtype, key).await.err().map(|error| error.to_string());
                }
            }
            _ = heartbeat_timer.tick() => {
                let preflight_error = runtime_preflight(&wtype);
                write_health(
                    &status_writer,
                    evaluate_health(
                        hub.connected_count(),
                        injection_error.as_deref().or(preflight_error.as_deref()),
                        input_error.as_deref(),
                    ),
                ).await;
            }
            message = receiver.recv() => {
                let Some(message) = message else { return Ok(()); };
                match message {
                    ReaderMessage::Event { path, generation: event_generation, event } => {
                        if active.get(&path).is_some_and(|device| device.generation == event_generation) {
                            let id = path.to_string_lossy();
                            for key in hub.handle(&id, event, started.elapsed()) {
                                injection_error = inject_key(&wtype, key).await.err().map(|error| error.to_string());
                            }
                        }
                    }
                    ReaderMessage::Disconnected { path, generation: event_generation, detail } => {
                        if active.get(&path).is_some_and(|device| device.generation == event_generation) {
                            tracing::info!(device = %path.display(), reason = %detail, "Gamepad disconnected");
                            active.remove(&path);
                            hub.disconnect(&path.to_string_lossy());
                        }
                    }
                }
            }
            signal = tokio::signal::ctrl_c() => {
                signal?;
                for device in active.values() {
                    device.task.abort();
                }
                return Ok(());
            }
        }
    }
}

fn scan_devices(
    input_dir: &Path,
    active: &mut HashMap<PathBuf, ActiveDevice>,
    hub: &mut InputHub,
    generation: &mut u64,
    sender: &mpsc::Sender<ReaderMessage>,
) -> Option<String> {
    let entries = match std::fs::read_dir(input_dir) {
        Ok(entries) => entries,
        Err(error) => return Some(format!("Cannot scan {}: {error}", input_dir.display())),
    };
    let mut present = HashSet::new();
    let mut permission_error = None;
    for entry in entries.flatten() {
        let path = entry.path();
        if !path
            .file_name()
            .and_then(OsStr::to_str)
            .is_some_and(|name| name.starts_with("event"))
        {
            continue;
        }
        present.insert(path.clone());
        if active.contains_key(&path) {
            continue;
        }
        let device = match Device::open(&path) {
            Ok(device) => device,
            Err(error) => {
                if error.kind() == io::ErrorKind::PermissionDenied {
                    permission_error = Some(format!("Cannot read {}: {error}", path.display()));
                }
                continue;
            }
        };
        let capabilities = device_capabilities(&device);
        if !capabilities.is_supported_gamepad() {
            continue;
        }
        let ranges = device_axis_ranges(&device);
        *generation = generation.wrapping_add(1);
        let device_generation = *generation;
        let reader_sender = sender.clone();
        let reader_path = path.clone();
        let task = tokio::spawn(async move {
            read_device(device, reader_path, device_generation, reader_sender).await;
        });
        tracing::info!(device = %path.display(), "Supported gamepad connected");
        hub.connect(path.to_string_lossy(), ranges);
        active.insert(
            path,
            ActiveDevice {
                generation: device_generation,
                task,
            },
        );
    }

    let removed = active
        .keys()
        .filter(|path| !present.contains(*path))
        .cloned()
        .collect::<Vec<_>>();
    for path in removed {
        if let Some(device) = active.remove(&path) {
            device.task.abort();
        }
        hub.disconnect(&path.to_string_lossy());
    }
    permission_error
}

fn device_capabilities(device: &Device) -> CapabilityDescriptor {
    CapabilityDescriptor {
        keys: device
            .supported_keys()
            .into_iter()
            .flat_map(|keys| keys.iter().map(|key| key.0))
            .collect(),
        axes: device
            .supported_absolute_axes()
            .into_iter()
            .flat_map(|axes| axes.iter().map(|axis| axis.0))
            .collect(),
    }
}

fn device_axis_ranges(device: &Device) -> HashMap<u16, AxisRange> {
    let Ok(state) = device.get_abs_state() else {
        return HashMap::new();
    };
    device
        .supported_absolute_axes()
        .into_iter()
        .flat_map(|axes| axes.iter())
        .filter_map(|axis| {
            state.get(axis.0 as usize).map(|info| {
                (
                    axis.0,
                    AxisRange {
                        minimum: info.minimum,
                        maximum: info.maximum,
                    },
                )
            })
        })
        .collect()
}

async fn read_device(
    device: Device,
    path: PathBuf,
    generation: u64,
    sender: mpsc::Sender<ReaderMessage>,
) {
    let mut events = match device.into_event_stream() {
        Ok(events) => events,
        Err(error) => {
            let _ = sender
                .send(ReaderMessage::Disconnected {
                    path,
                    generation,
                    detail: error.to_string(),
                })
                .await;
            return;
        }
    };
    loop {
        let event = match events.next_event().await {
            Ok(event) => event,
            Err(error) => {
                let _ = sender
                    .send(ReaderMessage::Disconnected {
                        path,
                        generation,
                        detail: error.to_string(),
                    })
                    .await;
                return;
            }
        };
        let input = match event.destructure() {
            EventSummary::Key(_, key, value) => Some(InputEvent::Button { code: key.0, value }),
            EventSummary::AbsoluteAxis(_, axis, value)
                if matches!(
                    axis.0,
                    code::ABS_X | code::ABS_Y | code::ABS_HAT0X | code::ABS_HAT0Y
                ) =>
            {
                Some(InputEvent::Axis {
                    code: axis.0,
                    value,
                })
            }
            _ => None,
        };
        if let Some(input) = input
            && sender
                .send(ReaderMessage::Event {
                    path: path.clone(),
                    generation,
                    event: input,
                })
                .await
                .is_err()
        {
            return;
        }
    }
}

fn runtime_preflight(wtype: &Path) -> Option<String> {
    if !command_exists(wtype) {
        return Some(format!("{} is not available", wtype.display()));
    }
    let runtime_dir = env::var_os("XDG_RUNTIME_DIR").map(PathBuf::from);
    let display = env::var_os("WAYLAND_DISPLAY").unwrap_or_else(|| "wayland-0".into());
    let Some(runtime_dir) = runtime_dir else {
        return Some("XDG_RUNTIME_DIR is not set".to_owned());
    };
    if !runtime_dir.join(display).exists() {
        return Some("Wayland display is not available".to_owned());
    }
    None
}

fn command_exists(command: &Path) -> bool {
    if command.components().count() > 1 {
        return command.is_file();
    }
    env::var_os("PATH").is_some_and(|paths| {
        env::split_paths(&paths).any(|directory| directory.join(command).is_file())
    })
}

async fn inject_key(wtype: &Path, key: &str) -> io::Result<()> {
    let mut command = Command::new(wtype);
    command.kill_on_drop(true).args(["-k", key]);
    let output = timeout(WTYPE_TIMEOUT, command.output())
        .await
        .map_err(|_| io::Error::new(io::ErrorKind::TimedOut, "wtype timed out"))??;
    if output.status.success() {
        return Ok(());
    }
    let detail = String::from_utf8_lossy(&output.stderr).trim().to_owned();
    Err(io::Error::other(if detail.is_empty() {
        format!("wtype exited with {}", output.status)
    } else {
        format!("wtype failed: {detail}")
    }))
}

async fn write_health(status_writer: &Path, health: Health) {
    let (state, detail) = match health {
        Health::Ready(detail) => ("ready", detail),
        Health::Degraded(detail) => ("degraded", detail),
        Health::Unavailable(detail) => ("unavailable", detail),
    };
    match Command::new(status_writer)
        .args(["gamepad", state, &detail])
        .status()
        .await
    {
        Ok(status) if status.success() => {}
        Ok(status) => tracing::warn!(%status, "Could not write gamepad health"),
        Err(error) => tracing::warn!(%error, "Could not invoke TV status writer"),
    }
}

#[cfg(test)]
mod tests {
    use std::os::unix::fs::PermissionsExt;

    use super::*;

    #[tokio::test]
    async fn wtype_failure_recovers_on_the_next_successful_injection() {
        let directory = tempfile::tempdir().unwrap();
        let command = directory.path().join("wtype");
        std::fs::write(
            &command,
            "#!/bin/sh\nstate=\"$0.state\"\nif [ ! -e \"$state\" ]; then : > \"$state\"; exit 1; fi\nexit 0\n",
        )
        .unwrap();
        std::fs::set_permissions(&command, std::fs::Permissions::from_mode(0o755)).unwrap();

        assert!(inject_key(&command, "Return").await.is_err());
        assert!(inject_key(&command, "Return").await.is_ok());
    }
}
