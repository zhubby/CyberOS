const STEP: [i32; 89] = [
    7, 8, 9, 10, 11, 12, 13, 14, 16, 17, 19, 21, 23, 25, 28, 31, 34, 37, 41, 45, 50, 55, 60, 66,
    73, 80, 88, 97, 107, 118, 130, 143, 157, 173, 190, 209, 230, 253, 279, 307, 337, 371, 408, 449,
    494, 544, 598, 658, 724, 796, 876, 963, 1060, 1166, 1282, 1411, 1552, 1707, 1878, 2066, 2272,
    2499, 2749, 3024, 3327, 3660, 4026, 4428, 4871, 5358, 5894, 6484, 7132, 7845, 8630, 9493,
    10442, 11487, 12635, 13899, 15289, 16818, 18500, 20350, 22385, 24623, 27086, 29794, 32767,
];
const INDEX: [i32; 8] = [-1, -1, -1, -1, 2, 4, 6, 8];

pub struct Capabilities {
    pub frame_bytes: usize,
    pub sample_rate: u32,
}
impl Capabilities {
    pub fn parse(payload: &[u8]) -> Result<Self, String> {
        if payload.len() < 7 || payload[0] != 11 || payload[1..3] != [1, 0] {
            return Err("Unsupported ATVV capability version".into());
        }
        let flags = if payload[3] & 3 == 0 {
            payload[4]
        } else {
            payload[3]
        };
        let frame_bytes = u16::from_be_bytes([payload[5], payload[6]]) as usize;
        if flags & 2 == 0 || !(1..=512).contains(&frame_bytes) {
            return Err("ATVV requires bounded 16 kHz IMA ADPCM frames".into());
        }
        Ok(Self {
            frame_bytes,
            sample_rate: 16000,
        })
    }
}

pub struct ImaAdpcm {
    predictor: i32,
    index: i32,
}
impl ImaAdpcm {
    pub fn new(predictor: i16, index: u8) -> Result<Self, String> {
        if index > 88 {
            return Err("Invalid ATVV codec sync".into());
        }
        Ok(Self {
            predictor: i32::from(predictor),
            index: i32::from(index),
        })
    }
    pub fn decode(&mut self, bytes: &[u8]) -> Vec<i16> {
        let mut samples = Vec::with_capacity(bytes.len() * 2);
        for byte in bytes {
            for nibble in [byte >> 4, byte & 15] {
                let step = STEP[self.index as usize];
                let mut difference = step >> 3;
                if nibble & 1 != 0 {
                    difference += step >> 2;
                }
                if nibble & 2 != 0 {
                    difference += step >> 1;
                }
                if nibble & 4 != 0 {
                    difference += step;
                }
                self.predictor = (self.predictor
                    + if nibble & 8 != 0 {
                        -difference
                    } else {
                        difference
                    })
                .clamp(-32768, 32767);
                self.index = (self.index + INDEX[(nibble & 7) as usize]).clamp(0, 88);
                samples.push(self.predictor as i16);
            }
        }
        samples
    }
}

pub struct Capture {
    frame_bytes: usize,
    max_samples: usize,
    samples: Vec<i16>,
    partial: Vec<u8>,
    decoder: Option<ImaAdpcm>,
}
impl Capture {
    pub fn new(frame_bytes: usize, seconds: u32) -> Result<Self, String> {
        if !(1..=512).contains(&frame_bytes) || !(1..=30).contains(&seconds) {
            return Err("Invalid ATVV capture limit".into());
        }
        Ok(Self {
            frame_bytes,
            max_samples: seconds as usize * 16000,
            samples: Vec::new(),
            partial: Vec::new(),
            decoder: None,
        })
    }
    pub fn synchronize(&mut self, predictor: i16, index: u8) -> Result<(), String> {
        self.decoder = Some(ImaAdpcm::new(predictor, index)?);
        self.partial.clear();
        Ok(())
    }
    pub fn push(&mut self, bytes: &[u8]) -> Result<(), String> {
        if bytes.len() > 1024 {
            return Err("Oversized ATVV notification".into());
        }
        let Some(decoder) = self.decoder.as_mut() else {
            return Ok(());
        };
        if self.samples.len() >= self.max_samples {
            return Ok(());
        }
        self.partial.extend_from_slice(bytes);
        while self.partial.len() >= self.frame_bytes && self.samples.len() < self.max_samples {
            let frame: Vec<u8> = self.partial.drain(..self.frame_bytes).collect();
            let samples = decoder.decode(&frame);
            self.samples.extend(
                samples
                    .into_iter()
                    .take(self.max_samples - self.samples.len()),
            );
        }
        Ok(())
    }
    #[cfg(test)]
    pub fn samples(&self) -> &[i16] {
        &self.samples
    }
    pub fn limit_reached(&self) -> bool {
        self.samples.len() >= self.max_samples
    }
    pub fn wav(&self) -> Option<Vec<u8>> {
        if self.samples.is_empty() {
            return None;
        }
        let data_bytes = self.samples.len() as u32 * 2;
        let mut output = Vec::with_capacity(data_bytes as usize + 44);
        output.extend_from_slice(b"RIFF");
        output.extend_from_slice(&(data_bytes + 36).to_le_bytes());
        output.extend_from_slice(b"WAVEfmt \x10\0\0\0\x01\0\x01\0");
        output.extend_from_slice(&16000u32.to_le_bytes());
        output.extend_from_slice(&32000u32.to_le_bytes());
        output.extend_from_slice(b"\x02\0\x10\0data");
        output.extend_from_slice(&data_bytes.to_le_bytes());
        for sample in &self.samples {
            output.extend_from_slice(&sample.to_le_bytes());
        }
        Some(output)
    }
}
