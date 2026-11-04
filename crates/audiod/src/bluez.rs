use futures_util::StreamExt;
use std::collections::HashMap;
use std::time::{Duration, Instant};
use zbus::{Connection, MatchRule, MessageStream, OwnedObjectPath, OwnedVariant, Proxy, Variant};

use crate::protocol::{Capabilities, Capture};
use crate::server::{Configuration, Device, Recording, Shared};

const ATVV: &str = "ab5e0001-5a21-4f05-bc7d-af01f617b664";
const TX: &str = "ab5e0002-5a21-4f05-bc7d-af01f617b664";
const AUDIO: &str = "ab5e0003-5a21-4f05-bc7d-af01f617b664";
const CONTROL: &str = "ab5e0004-5a21-4f05-bc7d-af01f617b664";
pub(crate) type Properties = HashMap<String, OwnedVariant>;
pub(crate) type Objects = HashMap<OwnedObjectPath, HashMap<String, Properties>>;

pub(crate) async fn system_connection() -> Result<Connection, String> {
    tokio::time::timeout(
        Duration::from_secs(5),
        zbus::connection::Builder::system()
            .method_timeout(Duration::from_secs(5))
            .build(),
    )
    .await
    .map_err(|_| "System D-Bus connection timed out")?
    .map_err(|_| "System D-Bus unavailable".into())
}

pub(crate) async fn objects(connection: &Connection) -> Result<Objects, String> {
    Proxy::new(
        connection,
        "org.bluez",
        "/",
        "org.freedesktop.DBus.ObjectManager",
    )
    .await
    .map_err(|_| "BlueZ unavailable")?
    .call("GetManagedObjects", &())
    .await
    .map_err(|_| "BlueZ enumeration failed".into())
}
pub(crate) fn text(properties: &Properties, key: &str) -> Option<String> {
    properties.get(key)?.downcast_ref::<String>().ok()
}
pub(crate) fn flag(properties: &Properties, key: &str) -> bool {
    properties
        .get(key)
        .and_then(|value| value.downcast_ref::<bool>().ok())
        .unwrap_or(false)
}

pub async fn devices() -> Result<Vec<Device>, String> {
    let connection = system_connection().await?;
    let objects = objects(&connection).await?;
    let mut devices = Vec::new();
    for (path, interfaces) in &objects {
        let Some(properties) = interfaces.get("org.bluez.Device1") else {
            continue;
        };
        if !flag(properties, "Paired") || !flag(properties, "Trusted") {
            continue;
        }
        let supported = text(properties, "Modalias")
            .is_some_and(|value| value.starts_with("bluetooth:v2717p32B8"))
            || objects.iter().any(|(child, interfaces)| {
                child.as_str().starts_with(&format!("{path}/"))
                    && interfaces
                        .get("org.bluez.GattService1")
                        .and_then(|props| text(props, "UUID"))
                        .as_deref()
                        == Some(ATVV)
            });
        if supported {
            devices.push(Device {
                id: format!("bluez:{path}"),
                name: text(properties, "Alias")
                    .or_else(|| text(properties, "Name"))
                    .unwrap_or_else(|| "ATVV remote".into()),
                connected: flag(properties, "Connected"),
            });
        }
    }
    devices.sort_by(|left, right| left.id.cmp(&right.id));
    Ok(devices)
}

pub async fn speakers() -> Result<Vec<Device>, String> {
    let connection = system_connection().await?;
    let objects = objects(&connection).await?;
    let mut speakers = Vec::new();
    for interfaces in objects.values() {
        let Some(properties) = interfaces.get("org.bluez.Device1") else {
            continue;
        };
        let uuids = properties
            .get("UUIDs")
            .and_then(|value| Vec::<String>::try_from(value.clone()).ok())
            .unwrap_or_default();
        if flag(properties, "Connected")
            && flag(properties, "Paired")
            && uuids
                .iter()
                .any(|uuid| uuid == "0000110b-0000-1000-8000-00805f9b34fb")
            && let Some(address) = text(properties, "Address")
        {
            speakers.push(Device {
                id: format!("alsa/bluealsa:DEV={address},PROFILE=a2dp"),
                name: text(properties, "Alias").unwrap_or(address),
                connected: true,
            });
        }
    }
    Ok(speakers)
}

pub async fn playback_devices() -> Result<Vec<Device>, String> {
    let connection = system_connection().await?;
    Ok(playback_inventory(&objects(&connection).await?))
}

pub(crate) fn playback_inventory(inventory: &Objects) -> Vec<Device> {
    let mut devices = Vec::new();
    for (path, interfaces) in inventory {
        let Some(properties) = interfaces.get("org.bluez.Device1") else {
            continue;
        };
        if !flag(properties, "Paired") || !flag(properties, "Trusted") {
            continue;
        }
        let supported = inventory.iter().any(|(child, interfaces)| {
            child.as_str().starts_with(&format!("{path}/"))
                && interfaces
                    .get("org.bluez.GattService1")
                    .and_then(|props| text(props, "UUID"))
                    .as_deref()
                    == Some(crate::playback::SERVICE)
        });
        if supported {
            devices.push(Device {
                id: format!("ble-playback:{path}"),
                name: format!(
                    "{} · StickS3 内置扬声器",
                    text(properties, "Alias").unwrap_or_else(|| "CyberController".into())
                ),
                connected: flag(properties, "Connected"),
            });
        }
    }
    devices.sort_by(|left, right| left.id.cmp(&right.id));
    devices
}

pub async fn run(state: Shared) {
    loop {
        let configuration = {
            let mut current = state.lock().await;
            if current.configured_at.elapsed() > Duration::from_secs(60) {
                current.config.enabled = false;
            }
            if !current.config.enabled {
                current.connected = false;
                current.protocol = "disabled".into();
            }
            current.config.clone()
        };
        if configuration.enabled {
            let result = session(state.clone(), configuration).await;
            let mut current = state.lock().await;
            current.connected = false;
            current.capture_id = None;
            if let Err(error) = result {
                current.error = Some(error);
                current.protocol = "disconnected".into();
            }
        }
        tokio::time::sleep(Duration::from_secs(2)).await;
    }
}

async fn write(proxy: &Proxy<'_>, bytes: &[u8]) -> Result<(), String> {
    let options: HashMap<&str, Variant<'_>> = HashMap::from([("type", Variant::from("command"))]);
    proxy
        .call::<_, _, ()>("WriteValue", &(bytes, options))
        .await
        .map_err(|_| "ATVV control write failed".into())
}

async fn session(state: Shared, configuration: Configuration) -> Result<(), String> {
    let connection = system_connection().await?;
    let device_path = configuration
        .input_device_id
        .as_deref()
        .and_then(|id| id.strip_prefix("bluez:"))
        .ok_or("Invalid input device")?;
    let inventory = objects(&connection).await?;
    let device_properties = inventory
        .iter()
        .find(|(path, _)| path.as_str() == device_path)
        .and_then(|(_, interfaces)| interfaces.get("org.bluez.Device1"))
        .ok_or("Input device unavailable")?;
    if !flag(device_properties, "Paired") || !flag(device_properties, "Trusted") {
        return Err("Input device is not trusted".into());
    }
    let device = Proxy::new(&connection, "org.bluez", device_path, "org.bluez.Device1")
        .await
        .map_err(|_| "Input unavailable")?;
    if !flag(device_properties, "Connected") {
        let _ = tokio::time::timeout(
            Duration::from_secs(10),
            device.call::<_, _, ()>("Connect", &()),
        )
        .await;
        return Err("Waiting for remote connection".into());
    }
    let characteristic = |uuid: &str| {
        inventory.iter().find_map(|(path, interfaces)| {
            if path.as_str().starts_with(&format!("{device_path}/"))
                && interfaces
                    .get("org.bluez.GattCharacteristic1")
                    .and_then(|props| text(props, "UUID"))
                    .as_deref()
                    == Some(uuid)
            {
                Some(path.to_string())
            } else {
                None
            }
        })
    };
    let tx_path = characteristic(TX).ok_or("ATVV TX not discovered")?;
    let audio_path = characteristic(AUDIO).ok_or("ATVV audio not discovered")?;
    let control_path = characteristic(CONTROL).ok_or("ATVV control not discovered")?;
    let tx = Proxy::new(
        &connection,
        "org.bluez",
        tx_path.as_str(),
        "org.bluez.GattCharacteristic1",
    )
    .await
    .map_err(|_| "ATVV TX unavailable")?;
    let audio = Proxy::new(
        &connection,
        "org.bluez",
        audio_path.as_str(),
        "org.bluez.GattCharacteristic1",
    )
    .await
    .map_err(|_| "ATVV audio unavailable")?;
    let control = Proxy::new(
        &connection,
        "org.bluez",
        control_path.as_str(),
        "org.bluez.GattCharacteristic1",
    )
    .await
    .map_err(|_| "ATVV control unavailable")?;
    let rule = MatchRule::builder()
        .msg_type(zbus::message::Type::Signal)
        .sender("org.bluez")
        .interface("org.freedesktop.DBus.Properties")
        .member("PropertiesChanged")
        .path_namespace(device_path)
        .build()
        .map_err(|_| "Invalid ATVV signal subscription")?;
    let mut events =
        MessageStream::for_match_rule(rule, &connection, std::num::NonZeroUsize::new(256))
            .await
            .map_err(|_| "ATVV signal subscription unavailable")?;
    control
        .call::<_, _, ()>("StartNotify", &())
        .await
        .map_err(|_| "ATVV control subscription failed")?;
    if audio.call::<_, _, ()>("StartNotify", &()).await.is_err() {
        let _ = control.call::<_, _, ()>("StopNotify", &()).await;
        return Err("ATVV audio subscription failed".into());
    }
    let mut stream_id = 0;
    let result = async {
        write(&tx, &[10, 1, 0, 0, 3, 3]).await?;
        let mut capabilities: Option<Capabilities> = None;
        let mut capture: Option<Capture> = None;
        let mut started = Instant::now();
        let mut timer = tokio::time::interval(Duration::from_millis(250));
        let handshake = Instant::now();
        loop {
            tokio::select! {
                notification = events.next() => {
                    let message = notification.ok_or("ATVV disconnected")?.map_err(|_| "ATVV notification failed")?;
                    let Some((is_control, data)) = atvv_notification(&message, &control_path, &audio_path) else { continue; };
                    if !is_control {
                        if let Some(capture) = capture.as_mut() { capture.push(&data)?; }
                        continue;
                    }
                    match data.first().copied() {
                        Some(11) => {
                            let negotiated = Capabilities::parse(&data)?;
                            let mut current = state.lock().await;
                            current.protocol = format!("ATVV 1.0 / {} Hz IMA ADPCM", negotiated.sample_rate);
                            current.connected = true;
                            current.error = None;
                            capabilities = Some(negotiated);
                        }
                        Some(8 | 16) if capabilities.is_some() && capture.is_none() => write(&tx, &[12, 0]).await?,
                        Some(4) if data.len() >= 4 && capture.is_none() => {
                            let caps = capabilities.as_ref().ok_or("Stream before capability negotiation")?;
                            stream_id = data[3];
                            if state.lock().await.begin_capture().is_none() { write(&tx, &[13, stream_id]).await?; continue; }
                            capture = Some(Capture::new(caps.frame_bytes, configuration.max_recording_seconds)?);
                            started = Instant::now();
                        }
                        Some(10) if data.len() >= 7 => {
                            if let Some(capture) = capture.as_mut() { capture.synchronize(i16::from_be_bytes([data[4], data[5]]), data[6])?; }
                        }
                        Some(0) if capture.is_some() => {
                                write(&tx, &[13, stream_id]).await?;
                                finish(&state, &configuration, capture.take()).await;
                        }
                        _ => {}
                    }
                }
                _ = timer.tick() => {
                    {
                        let current = state.lock().await;
                        if current.config != configuration || current.configured_at.elapsed() > Duration::from_secs(60) { break; }
                    }
                    if !device.get_property::<bool>("Connected").await.unwrap_or(false) { return Err("Remote disconnected".into()); }
                    if capabilities.is_none() && handshake.elapsed() > Duration::from_secs(10) { return Err("ATVV capability negotiation timed out".into()); }
                    if capture.as_ref().is_some_and(|capture| capture.limit_reached() || started.elapsed() >= Duration::from_secs(configuration.max_recording_seconds.into())) {
                        write(&tx, &[13, stream_id]).await?;
                        finish(&state, &configuration, capture.take()).await;
                    }
                }
            }
        }
        Ok(())
    }.await;
    let _ = write(&tx, &[13, stream_id]).await;
    let _ = audio.call::<_, _, ()>("StopNotify", &()).await;
    let _ = control.call::<_, _, ()>("StopNotify", &()).await;
    result
}

pub(crate) fn atvv_notification(
    message: &zbus::Message,
    control_path: &str,
    audio_path: &str,
) -> Option<(bool, Vec<u8>)> {
    let header = message.header();
    let path = header.path()?.as_str();
    if path != control_path && path != audio_path {
        return None;
    }
    let (interface, changed, _): (String, Properties, Vec<String>) =
        message.body().deserialize().ok()?;
    if interface != "org.bluez.GattCharacteristic1" {
        return None;
    }
    let bytes = Vec::<u8>::try_from(changed.get("Value")?.clone()).ok()?;
    Some((path == control_path, bytes))
}

async fn finish(state: &Shared, configuration: &Configuration, capture: Option<Capture>) {
    let mut current = state.lock().await;
    if let Some(id) = current.capture_id.take() {
        if let Some(wav) = capture.and_then(|capture| capture.wav()) {
            current.recordings.push_back(Recording {
                id,
                device_id: configuration.input_device_id.clone().unwrap_or_default(),
                wav,
                created: Instant::now(),
            });
        } else {
            current.error = Some("Empty recording or missing codec sync".into());
        }
    }
}
