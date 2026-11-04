use crate::protocol::{Capabilities, Capture, ImaAdpcm};

#[test]
fn negotiates_v1_standard_and_swapped_codec_firmware() {
    for payload in [
        [0x0b, 1, 0, 2, 3, 0, 120, 0, 0],
        [0x0b, 1, 0, 0, 3, 0, 120, 0, 0],
    ] {
        let caps = Capabilities::parse(&payload).unwrap();
        assert_eq!(caps.frame_bytes, 120);
        assert_eq!(caps.sample_rate, 16000);
    }
}

#[test]
fn rejects_unknown_version_codec_and_frame_size() {
    for payload in [
        vec![],
        vec![11, 1],
        vec![11, 0, 4, 2, 3, 0, 120],
        vec![11, 1, 0, 1, 0, 0, 120],
        vec![11, 1, 0, 2, 3, 0, 0],
        vec![11, 1, 0, 2, 3, 255, 255],
    ] {
        assert!(Capabilities::parse(&payload).is_err());
    }
}

#[test]
fn decodes_high_nibble_first_with_continuous_state() {
    let mut decoder = ImaAdpcm::new(0, 0).unwrap();
    assert_eq!(decoder.decode(&[0x12]), vec![1, 4]);
    assert_eq!(decoder.decode(&[0x70, 0xff]), vec![15, 17, -8, -64]);
    assert_eq!(
        ImaAdpcm::new(1000, 10).unwrap().decode(&[0x08]),
        vec![1002, 1000]
    );
}

#[test]
fn clamps_samples_and_rejects_invalid_sync_indexes() {
    assert_eq!(
        ImaAdpcm::new(32760, 88).unwrap().decode(&[0x77]),
        vec![32767, 32767]
    );
    assert_eq!(
        ImaAdpcm::new(-32760, 88).unwrap().decode(&[0xff]),
        vec![-32768, -32768]
    );
    assert!(ImaAdpcm::new(0, 89).is_err());
}

#[test]
fn fragments_frames_and_discards_old_partial_frame_at_sync() {
    let mut capture = Capture::new(2, 30).unwrap();
    capture.push(&[0x12, 0x70]).unwrap();
    assert!(capture.wav().is_none());
    capture.synchronize(0, 0).unwrap();
    capture.push(&[0x12]).unwrap();
    capture.push(&[0x70, 0xff]).unwrap();
    assert_eq!(capture.samples(), &[1, 4, 15, 17]);
    capture.synchronize(1000, 10).unwrap();
    capture.push(&[0x08, 0x08]).unwrap();
    assert_eq!(&capture.samples()[4..], &[1002, 1000, 1002, 1001]);
}

#[test]
fn duration_and_notification_limits_are_enforced() {
    let mut capture = Capture::new(120, 1).unwrap();
    capture.synchronize(0, 0).unwrap();
    for _ in 0..9 {
        capture.push(&[0; 1024]).unwrap();
    }
    assert!(capture.limit_reached());
    assert_eq!(capture.samples().len(), 16000);
    let wav = capture.wav().unwrap();
    assert_eq!(&wav[..4], b"RIFF");
    assert_eq!(&wav[8..12], b"WAVE");
    assert_eq!(wav.len(), 32044);
    assert!(capture.push(&[0; 1025]).is_err());
    for (frame, seconds) in [(0, 30), (513, 30), (120, 0), (120, 31)] {
        assert!(Capture::new(frame, seconds).is_err());
    }
}

#[test]
fn ordered_bluez_events_preserve_sync_audio_and_release_without_truncation() {
    let control = "/org/bluez/hci0/dev_AA_BB_CC_DD_EE_FF/service0001/char0004";
    let audio = "/org/bluez/hci0/dev_AA_BB_CC_DD_EE_FF/service0001/char0003";
    let mut capture = Capture::new(2, 1).unwrap();
    let mut finished = None;
    for (path, payload) in [
        (control, vec![10u8, 0, 0, 1, 0, 0, 0]),
        (audio, vec![0x12]),
        (audio, vec![0x70]),
        (control, vec![0]),
    ] {
        let changed: std::collections::HashMap<&str, zbus::Variant<'_>> =
            std::collections::HashMap::from([("Value", zbus::Variant::from(payload))]);
        let message =
            zbus::Message::signal(path, "org.freedesktop.DBus.Properties", "PropertiesChanged")
                .build(&(
                    "org.bluez.GattCharacteristic1",
                    changed,
                    Vec::<String>::new(),
                ))
                .unwrap();
        let (is_control, bytes) =
            crate::bluez::atvv_notification(&message, control, audio).unwrap();
        if !is_control {
            capture.push(&bytes).unwrap();
        } else if bytes[0] == 10 {
            capture.synchronize(0, 0).unwrap();
        } else {
            finished = capture.wav();
        }
    }
    let wav = finished.unwrap();
    assert_eq!(&wav[44..], &[1, 0, 4, 0, 15, 0, 17, 0]);
}
