use crate::playback::{Clip, Status, Transfer, crc32, input_for_output};
use crate::protocol::ImaAdpcm;

#[test]
fn encoder_matches_independent_ima_reference_and_high_nibble_order() {
    let clip = Clip::from_pcm(&[1, 4, 15, 17, -8, -64]).unwrap();
    assert_eq!(clip.data, [0x12, 0x70, 0xff]);
    assert_eq!(
        ImaAdpcm::new(0, 0).unwrap().decode(&clip.data),
        [1, 4, 15, 17, -8, -64]
    );
    assert_eq!(crc32(b"123456789"), 0xcbf43926);
    assert_eq!(crc32(&[]), 0);
}

#[test]
fn start_has_default_mtu_size_and_little_endian_golden_layout() {
    let clip = Clip::from_pcm(&[0, 0, 0]).unwrap();
    assert_eq!(clip.data, [0, 0]);
    assert_eq!(
        clip.start(0x12345678, 7).unwrap(),
        [
            1, 1, 0x78, 0x56, 0x34, 0x12, 3, 0, 0, 0, 2, 0, 0, 0, 0xff, 0x12, 0xd9, 0x41, 7, 1,
        ]
    );
    assert!(clip.start(0, 7).is_err());
    assert!(clip.start(1, 101).is_err());
    assert!(Clip::from_pcm(&[]).is_err());
    assert!(Clip::from_pcm(&vec![0; 16000 * 130 + 1]).is_err());
}

#[test]
fn transfer_uses_negotiated_mtu_and_waits_for_acknowledged_windows() {
    let clip = Clip::from_pcm(&[0; 241]).unwrap();
    let mut transfer = Transfer::new(42, &clip, 23).unwrap();
    assert!(transfer.packet().is_err());
    transfer
        .acknowledge(Status::receiving(42, 0, 0, 8))
        .unwrap();
    for sequence in 0..8u32 {
        let packet = transfer.packet().unwrap().unwrap();
        assert_eq!(packet.len(), 20);
        assert_eq!(&packet[..4], &42u32.to_le_bytes());
        assert_eq!(&packet[4..8], &sequence.to_le_bytes());
    }
    assert!(transfer.packet().is_err());
    assert!(
        transfer
            .acknowledge(Status::receiving(42, 8, 95, 8))
            .is_err()
    );
    transfer
        .acknowledge(Status::receiving(42, 8, 96, 8))
        .unwrap();
    assert_eq!(transfer.packet().unwrap().unwrap().len(), 20);
    assert_eq!(transfer.packet().unwrap().unwrap().len(), 20);
    assert_eq!(transfer.packet().unwrap().unwrap().len(), 9);
    assert!(transfer.packet().unwrap().is_none());
    assert!(!transfer.received());
    transfer
        .acknowledge(Status::receiving(42, 11, 121, 8))
        .unwrap();
    assert!(transfer.received());
    let mut large = Transfer::new(42, &clip, 247).unwrap();
    large.acknowledge(Status::receiving(42, 0, 0, 8)).unwrap();
    assert_eq!(large.packet().unwrap().unwrap().len(), 129);
    assert!(Transfer::new(42, &clip, 22).is_err());
    let long = Clip::from_pcm(&[0; 1400]).unwrap();
    let mut maximum = Transfer::new(42, &long, 517).unwrap();
    maximum.acknowledge(Status::receiving(42, 0, 0, 8)).unwrap();
    assert_eq!(maximum.packet().unwrap().unwrap().len(), 512);
}

#[test]
fn status_rejects_corrupt_stale_or_premature_completion() {
    let clip = Clip::from_pcm(&[0; 32]).unwrap();
    let mut transfer = Transfer::new(42, &clip, 23).unwrap();
    assert!(Status::parse(&[]).is_err());
    assert!(Status::parse(&[0; 20]).is_err());
    assert!(
        transfer
            .acknowledge(Status::receiving(43, 0, 0, 8))
            .is_err()
    );
    assert!(
        transfer
            .acknowledge(Status::receiving(42, 1, 12, 8))
            .is_err()
    );
    assert!(
        transfer
            .acknowledge(Status::receiving(42, 0, 0, 9))
            .is_err()
    );
    let completed =
        Status::parse(&[1, 3, 42, 0, 0, 0, 2, 0, 0, 0, 16, 0, 0, 0, 0, 0, 0, 0, 0, 0]).unwrap();
    assert!(transfer.complete(&completed).is_err());
    transfer
        .acknowledge(Status::receiving(42, 0, 0, 8))
        .unwrap();
    transfer.packet().unwrap();
    transfer.packet().unwrap();
    transfer
        .acknowledge(Status::receiving(42, 2, 16, 8))
        .unwrap();
    assert!(transfer.complete(&completed).is_ok());
    let error =
        Status::parse(&[1, 5, 42, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 4, 0, 0, 0]).unwrap();
    assert!(transfer.complete(&error).is_err());
}

#[test]
fn ble_output_is_bound_to_the_exact_selected_input() {
    assert_eq!(
        input_for_output("ble-playback:/org/bluez/hci0/dev_AA_BB_CC_DD_EE_FF"),
        Some("bluez:/org/bluez/hci0/dev_AA_BB_CC_DD_EE_FF".into())
    );
    assert_eq!(input_for_output("alsa/hdmi"), None);
    assert_eq!(input_for_output("ble-playback:/other/path"), None);
}

#[tokio::test]
async fn converts_real_24khz_wav_to_bounded_16khz_adpcm() {
    let _process_guard = crate::PROCESS_TEST_LOCK.lock().await;
    let mut wav = b"RIFF".to_vec();
    wav.extend_from_slice(&9636u32.to_le_bytes());
    wav.extend_from_slice(b"WAVEfmt \x10\0\0\0\x01\0\x01\0");
    wav.extend_from_slice(&24000u32.to_le_bytes());
    wav.extend_from_slice(&48000u32.to_le_bytes());
    wav.extend_from_slice(&[2, 0, 16, 0]);
    wav.extend_from_slice(b"data");
    wav.extend_from_slice(&9600u32.to_le_bytes());
    wav.extend_from_slice(&[0; 9600]);
    let clip = tokio::time::timeout(
        std::time::Duration::from_secs(5),
        crate::ble_output::convert(&wav),
    )
    .await
    .unwrap()
    .unwrap();
    assert_eq!(clip.samples, 3200);
    assert_eq!(clip.data, vec![0; 1600]);
    assert_eq!(clip.duration(), std::time::Duration::from_millis(200));
    assert!(
        tokio::time::timeout(
            std::time::Duration::from_secs(5),
            crate::ble_output::convert(b"not a wav")
        )
        .await
        .unwrap()
        .is_err()
    );
}
