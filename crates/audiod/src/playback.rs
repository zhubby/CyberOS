pub const SERVICE: &str = "d9870001-bc7a-4c40-8c98-781a66a7b401";
pub const CONTROL: &str = "d9870002-bc7a-4c40-8c98-781a66a7b401";
pub const DATA: &str = "d9870003-bc7a-4c40-8c98-781a66a7b401";
pub const STATUS: &str = "d9870004-bc7a-4c40-8c98-781a66a7b401";
pub const MAX_SAMPLES: usize = 16000 * 130;
pub const MAX_BYTES: usize = 2 * 1024 * 1024;

pub fn input_for_output(output: &str) -> Option<String> {
    let path = output.strip_prefix("ble-playback:")?;
    let suffix = path.strip_prefix("/org/bluez/hci")?;
    let (adapter, address) = suffix.split_once("/dev_")?;
    if adapter.is_empty()
        || !adapter.bytes().all(|byte| byte.is_ascii_digit())
        || address.len() != 17
        || !address
            .split('_')
            .all(|part| part.len() == 2 && part.bytes().all(|byte| byte.is_ascii_hexdigit()))
    {
        return None;
    }
    Some(format!("bluez:{path}"))
}

pub fn crc32(bytes: &[u8]) -> u32 {
    let mut crc = !0u32;
    for byte in bytes {
        crc ^= u32::from(*byte);
        for _ in 0..8 {
            crc = (crc >> 1) ^ (0xedb88320 & (0u32.wrapping_sub(crc & 1)));
        }
    }
    !crc
}

pub struct Clip {
    pub data: Vec<u8>,
    pub samples: u32,
}

impl Clip {
    pub fn from_pcm(samples: &[i16]) -> Result<Self, String> {
        if samples.is_empty() || samples.len() > MAX_SAMPLES {
            return Err("BLE audio must be between one sample and 130 seconds".into());
        }
        let data = crate::protocol::ImaAdpcm::new(0, 0)?.encode(samples);
        if data.len() > MAX_BYTES {
            return Err("BLE audio exceeds 2 MiB".into());
        }
        Ok(Self {
            data,
            samples: samples.len() as u32,
        })
    }
    pub fn start(&self, id: u32, volume: u8) -> Result<Vec<u8>, String> {
        if id == 0 || volume > 100 {
            return Err("Invalid BLE playback id or volume".into());
        }
        let mut bytes = vec![1, 1];
        bytes.extend_from_slice(&id.to_le_bytes());
        bytes.extend_from_slice(&self.samples.to_le_bytes());
        bytes.extend_from_slice(&(self.data.len() as u32).to_le_bytes());
        bytes.extend_from_slice(&crc32(&self.data).to_le_bytes());
        bytes.extend_from_slice(&[volume, 1]);
        Ok(bytes)
    }
    pub fn duration(&self) -> std::time::Duration {
        std::time::Duration::from_millis((u64::from(self.samples) * 1000).div_ceil(16000))
    }
}

pub struct Status {
    pub state: u8,
    pub id: u32,
    pub sequence: u32,
    pub bytes: u32,
    pub credits: u16,
    pub error: u16,
}
impl Status {
    pub fn parse(bytes: &[u8]) -> Result<Self, String> {
        if bytes.len() != 20
            || bytes[0] != 1
            || !(1..=5).contains(&bytes[1])
            || bytes[18..] != [0, 0]
        {
            return Err("Invalid BLE playback status".into());
        }
        Ok(Self {
            state: bytes[1],
            id: u32::from_le_bytes(bytes[2..6].try_into().unwrap()),
            sequence: u32::from_le_bytes(bytes[6..10].try_into().unwrap()),
            bytes: u32::from_le_bytes(bytes[10..14].try_into().unwrap()),
            credits: u16::from_le_bytes(bytes[14..16].try_into().unwrap()),
            error: u16::from_le_bytes(bytes[16..18].try_into().unwrap()),
        })
    }
    #[cfg(test)]
    pub fn receiving(id: u32, sequence: u32, bytes: u32, credits: u16) -> Self {
        Self {
            state: 1,
            id,
            sequence,
            bytes,
            credits,
            error: 0,
        }
    }
}

pub struct Transfer<'clip> {
    id: u32,
    clip: &'clip Clip,
    payload: usize,
    pub sequence: u32,
    pub offset: usize,
    acknowledged: usize,
    acknowledged_sequence: u32,
    credits: u16,
}
impl<'clip> Transfer<'clip> {
    pub fn new(id: u32, clip: &'clip Clip, mtu: u16) -> Result<Self, String> {
        if id == 0 || !(23..=517).contains(&mtu) {
            return Err("Invalid BLE MTU or playback id".into());
        }
        Ok(Self {
            id,
            clip,
            payload: (usize::from(mtu) - 3).min(512) - 8,
            sequence: 0,
            offset: 0,
            acknowledged: 0,
            acknowledged_sequence: 0,
            credits: 0,
        })
    }
    pub fn packet(&mut self) -> Result<Option<Vec<u8>>, String> {
        if self.offset == self.clip.data.len() {
            return Ok(None);
        }
        if self.credits == 0 {
            return Err("Waiting for BLE receiver credits".into());
        }
        let end = (self.offset + self.payload).min(self.clip.data.len());
        let mut bytes = self.id.to_le_bytes().to_vec();
        bytes.extend_from_slice(&self.sequence.to_le_bytes());
        bytes.extend_from_slice(&self.clip.data[self.offset..end]);
        self.offset = end;
        self.sequence += 1;
        self.credits -= 1;
        Ok(Some(bytes))
    }
    pub fn acknowledge(&mut self, status: Status) -> Result<(), String> {
        if status.id != self.id
            || status.state != 1
            || status.error != 0
            || status.credits > 8
            || status.sequence > self.sequence
            || status.sequence < self.acknowledged_sequence
            || status.bytes as usize
                != (status.sequence as usize * self.payload).min(self.clip.data.len())
        {
            return Err("BLE receiver rejected audio or acknowledged invalid data".into());
        }
        self.acknowledged = status.bytes as usize;
        self.acknowledged_sequence = status.sequence;
        self.credits = status
            .credits
            .saturating_sub((self.sequence - status.sequence) as u16);
        Ok(())
    }
    pub fn received(&self) -> bool {
        self.acknowledged == self.clip.data.len()
    }
    pub fn complete(&self, status: &Status) -> Result<(), String> {
        if !self.received()
            || status.id != self.id
            || status.state != 3
            || status.error != 0
            || status.sequence != self.sequence
            || status.bytes as usize != self.clip.data.len()
        {
            return Err("Device did not confirm speaker playback completion".into());
        }
        Ok(())
    }
}
