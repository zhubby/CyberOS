use std::process::Stdio;
use std::time::Duration;
use tokio::io::AsyncWriteExt;
use tokio::process::Command;

use crate::server::{Device, Shared};

pub async fn devices() -> Result<Vec<Device>, String> {
    let output = tokio::time::timeout(
        Duration::from_secs(5),
        Command::new("mpv")
            .args(["--no-config", "--audio-device=help"])
            .kill_on_drop(true)
            .output(),
    )
    .await
    .map_err(|_| "Output enumeration timed out")?
    .map_err(|_| "mpv is unavailable")?;
    let text = format!(
        "{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    let mut devices = parse_devices(&text);
    for device in crate::bluez::speakers().await.unwrap_or_default() {
        devices.push(device);
    }
    Ok(devices)
}

fn parse_devices(text: &str) -> Vec<Device> {
    text.lines()
        .filter_map(|line| {
            let trimmed = line.trim().strip_prefix('\'')?;
            let (id, name) = trimmed.split_once('\'')?;
            if !id.starts_with("alsa/")
                || ["alsa/default", "alsa/sysdefault", "alsa/bluealsa"].contains(&id)
            {
                return None;
            }
            Some(Device {
                id: id.into(),
                name: name
                    .trim()
                    .trim_start_matches('(')
                    .trim_end_matches(')')
                    .into(),
                connected: true,
            })
        })
        .collect()
}

pub async fn play(
    state: Shared,
    wav: Vec<u8>,
    device: String,
    volume: u8,
    generation: u64,
    mut disconnected: tokio::sync::watch::Receiver<bool>,
) -> Result<(), String> {
    if wav.len() < 44
        || wav.len() > 6 * 1024 * 1024
        || &wav[..4] != b"RIFF"
        || &wav[8..12] != b"WAVE"
    {
        return Err("Expected bounded WAV audio".into());
    }
    if !devices()
        .await?
        .iter()
        .any(|output| output.id == device && output.connected)
    {
        return Err("Selected output is offline; no fallback is allowed".into());
    }
    let mut cancel = {
        let mut current = state.lock().await;
        if current.playing
            || current.capture_id.is_some()
            || generation != current.generation
            || *disconnected.borrow()
        {
            return Err("Speech interrupted by newer input".into());
        }
        current.playing = true;
        current.playback_cancel.subscribe()
    };
    let result = async {
        let mut child = Command::new("mpv").args(["--no-config", "--no-video", "--no-terminal", "--really-quiet", "--ao=alsa", "--audio-fallback-to-null=no"])
            .arg(format!("--audio-device={device}")).arg(format!("--volume={volume}"))
            .args(["--", "fd://0"]).stdin(Stdio::piped()).stdout(Stdio::null()).stderr(Stdio::null()).kill_on_drop(true)
            .spawn().map_err(|_| "Speech player unavailable")?;
        let mut stdin = child.stdin.take().ok_or("Speech input unavailable")?;
        let writer = tokio::spawn(async move { stdin.write_all(&wav).await });
        let outcome = tokio::select! {
            status = child.wait() => status.map_err(|_| "Speech playback failed").and_then(|status| if status.success() { Ok(()) } else { Err("Speech output failed; no fallback attempted") }),
            _ = cancel.changed() => { let _ = child.kill().await; Err("Speech interrupted") },
            _ = disconnected.changed() => { let _ = child.kill().await; Err("Speech caller disconnected") },
            _ = tokio::time::sleep(Duration::from_secs(130)) => { let _ = child.kill().await; Err("Speech playback timed out") },
        };
        writer.abort();
        outcome.map_err(str::to_string)
    }.await;
    state.lock().await.playing = false;
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn excludes_implicit_output_fallbacks() {
        let devices = parse_devices(
            " 'auto' (default)\n 'alsa/default' (default)\n 'alsa/sysdefault' (default)\n 'alsa/bluealsa' (default Bluetooth)\n 'alsa/hdmi:CARD=vc4hdmi0,DEV=0' (HDMI)\n 'alsa/usb:CARD=USB' (USB)",
        );
        assert_eq!(devices.len(), 2);
        assert!(devices.iter().all(|device| device.id.starts_with("alsa/")));
    }
}
