use std::collections::HashMap;
use std::process::Stdio;
use std::time::{Duration, Instant};

use futures_util::StreamExt;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::process::Command;
use tokio::sync::watch;
use zbus::{Proxy, Variant};

use crate::bluez::{flag, objects, system_connection, text};
use crate::playback::{self, Clip, Status, Transfer};

pub(crate) async fn convert(wav: &[u8]) -> Result<Clip, String> {
    let mut child = Command::new("ffmpeg")
        .args([
            "-hide_banner",
            "-loglevel",
            "error",
            "-nostdin",
            "-protocol_whitelist",
            "pipe",
            "-i",
            "pipe:0",
            "-map",
            "0:a:0",
            "-vn",
            "-ac",
            "1",
            "-ar",
            "16000",
            "-c:a",
            "pcm_s16le",
            "-f",
            "s16le",
            "pipe:1",
        ])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .map_err(|_| "BLE WAV converter unavailable")?;
    let mut stdin = child.stdin.take().ok_or("Converter input unavailable")?;
    let mut stdout = child
        .stdout
        .take()
        .ok_or("Converter output unavailable")?
        .take((playback::MAX_SAMPLES * 2 + 1) as u64);
    let mut pcm = Vec::new();
    tokio::try_join!(
        async move {
            stdin.write_all(wav).await?;
            drop(stdin);
            Ok::<(), std::io::Error>(())
        },
        stdout.read_to_end(&mut pcm)
    )
    .map_err(|_| "WAV conversion failed")?;
    if pcm.is_empty() || !pcm.len().is_multiple_of(2) || pcm.len() > playback::MAX_SAMPLES * 2 {
        return Err("BLE WAV is empty or exceeds 130 seconds".into());
    }
    if !child
        .wait()
        .await
        .map_err(|_| "WAV conversion failed")?
        .success()
    {
        return Err("Invalid WAV for BLE output".into());
    }
    Clip::from_pcm(
        &pcm.chunks_exact(2)
            .map(|bytes| i16::from_le_bytes([bytes[0], bytes[1]]))
            .collect::<Vec<_>>(),
    )
}

async fn write(proxy: &Proxy<'_>, bytes: &[u8]) -> Result<(), String> {
    let options: HashMap<&str, Variant<'_>> = HashMap::from([("type", Variant::from("request"))]);
    proxy
        .call::<_, _, ()>("WriteValue", &(bytes, options))
        .await
        .map_err(|_| "BLE playback write failed".into())
}

fn control(opcode: u8, id: u32) -> Vec<u8> {
    let mut bytes = vec![1, opcode];
    bytes.extend_from_slice(&id.to_le_bytes());
    bytes
}

pub async fn play(
    wav: &[u8],
    output: &str,
    volume: u8,
    mut cancel: watch::Receiver<u64>,
    mut disconnected: watch::Receiver<bool>,
) -> Result<(), String> {
    let path = output
        .strip_prefix("ble-playback:")
        .ok_or("Invalid BLE playback output")?;
    let connection = system_connection().await?;
    let inventory = objects(&connection).await?;
    let properties = inventory
        .iter()
        .find(|(device, _)| device.as_str() == path)
        .and_then(|(_, interfaces)| interfaces.get("org.bluez.Device1"))
        .ok_or("BLE output unavailable")?;
    if !flag(properties, "Paired") || !flag(properties, "Trusted") || !flag(properties, "Connected")
    {
        return Err("BLE output disconnected or untrusted; no fallback allowed".into());
    }
    let service = inventory
        .iter()
        .find(|(service, interfaces)| {
            service.as_str().starts_with(&format!("{path}/"))
                && interfaces
                    .get("org.bluez.GattService1")
                    .and_then(|props| text(props, "UUID"))
                    .as_deref()
                    == Some(playback::SERVICE)
        })
        .map(|(path, _)| path.as_str())
        .ok_or("BLE playback service unavailable")?;
    let characteristic = |uuid: &str| {
        inventory.iter().find_map(|(path, interfaces)| {
            let properties = interfaces.get("org.bluez.GattCharacteristic1")?;
            if path.as_str().starts_with(&format!("{service}/"))
                && text(properties, "UUID").as_deref() == Some(uuid)
            {
                Some(path.to_string())
            } else {
                None
            }
        })
    };
    let control_path = characteristic(playback::CONTROL).ok_or("BLE control unavailable")?;
    let data_path = characteristic(playback::DATA).ok_or("BLE data unavailable")?;
    let status_path = characteristic(playback::STATUS).ok_or("BLE status unavailable")?;
    let control_proxy = Proxy::new(
        &connection,
        "org.bluez",
        control_path.as_str(),
        "org.bluez.GattCharacteristic1",
    )
    .await
    .map_err(|_| "BLE control unavailable")?;
    let data = Proxy::new(
        &connection,
        "org.bluez",
        data_path.as_str(),
        "org.bluez.GattCharacteristic1",
    )
    .await
    .map_err(|_| "BLE data unavailable")?;
    let status_proxy = Proxy::new(
        &connection,
        "org.bluez",
        status_path.as_str(),
        "org.bluez.GattCharacteristic1",
    )
    .await
    .map_err(|_| "BLE status unavailable")?;
    let device = Proxy::new(&connection, "org.bluez", path, "org.bluez.Device1")
        .await
        .map_err(|_| "BLE device unavailable")?;
    let mut events = status_proxy
        .receive_property_changed::<Vec<u8>>("Value")
        .await;
    let random = uuid::Uuid::new_v4();
    let id = u32::from_le_bytes(random.as_bytes()[..4].try_into().unwrap()).max(1);
    let mut connected = tokio::time::interval(Duration::from_millis(500));
    let mut disconnected_device = Box::pin(async {
        loop {
            connected.tick().await;
            if !device
                .get_property::<bool>("Connected")
                .await
                .unwrap_or(false)
            {
                break;
            }
        }
    });
    let operation = async {
        status_proxy
            .call::<_, _, ()>("StartNotify", &())
            .await
            .map_err(|_| "BLE status subscription failed")?;
        let clip = tokio::time::timeout(Duration::from_secs(10), convert(wav))
            .await
            .map_err(|_| "WAV conversion timed out")??;
        let mtu = data.get_property::<u16>("MTU").await.unwrap_or(23);
        let mut transfer = Transfer::new(id, &clip, mtu)?;
        let transfer_started = Instant::now();
        tokio::time::timeout(Duration::from_secs(120), async {
            write(&control_proxy, &clip.start(id, volume)?).await?;
            while !transfer.received() {
                let status = tokio::time::timeout(Duration::from_secs(10), async {
                    loop {
                        let value = events
                            .next()
                            .await
                            .ok_or("BLE status disconnected")?
                            .get()
                            .await
                            .map_err(|_| "BLE status read failed")?;
                        let status = Status::parse(&value)?;
                        if status.id == id {
                            break Ok::<Status, String>(status);
                        }
                    }
                })
                .await
                .map_err(|_| "BLE receive acknowledgement timed out")??;
                transfer.acknowledge(status)?;
                while let Ok(Some(packet)) = transfer.packet() {
                    write(&data, &packet).await?;
                }
            }
            write(&control_proxy, &control(2, id)).await
        })
        .await
        .map_err(|_| "BLE transfer exceeded 120 seconds")??;
        tracing::info!(
            playback_id = id,
            ble_transfer_ms = transfer_started.elapsed().as_millis() as u64,
            bytes = clip.data.len(),
            mtu,
            "BLE segment received and submitted for validation"
        );
        let playback_started = Instant::now();
        tokio::time::timeout(clip.duration() + Duration::from_secs(5), async {
            loop {
                let value = events
                    .next()
                    .await
                    .ok_or("BLE status disconnected")?
                    .get()
                    .await
                    .map_err(|_| "BLE status read failed")?;
                let status = Status::parse(&value)?;
                if status.id != id {
                    continue;
                }
                match status.state {
                    1 | 2 if status.error == 0 => {}
                    3 => {
                        transfer.complete(&status)?;
                        break Ok::<(), String>(());
                    }
                    _ => {
                        return Err(format!(
                            "BLE device cancelled or rejected playback (error {})",
                            status.error
                        ));
                    }
                }
            }
        })
        .await
        .map_err(|_| "Device speaker completion timed out")??;
        tracing::info!(
            playback_id = id,
            device_playback_ms = playback_started.elapsed().as_millis() as u64,
            "Device confirmed speaker playback completed"
        );
        Ok::<(), String>(())
    };
    let result = if *disconnected.borrow() || cancel.has_changed().unwrap_or(true) {
        Err("BLE speech interrupted before transfer".into())
    } else {
        tokio::select! {
            result = tokio::time::timeout(Duration::from_secs(265), operation) => result.map_err(|_| "BLE playback total deadline exceeded".to_string()).and_then(|result| result),
            _ = cancel.changed() => Err("BLE speech interrupted".into()),
            _ = disconnected.changed() => Err("BLE speech caller disconnected".into()),
            _ = &mut disconnected_device => Err("BLE output disconnected; no fallback allowed".into()),
        }
    };
    if result.is_err() {
        let _ = tokio::time::timeout(
            Duration::from_secs(1),
            write(&control_proxy, &control(3, id)),
        )
        .await;
    }
    let _ = status_proxy.call::<_, _, ()>("StopNotify", &()).await;
    result
}
