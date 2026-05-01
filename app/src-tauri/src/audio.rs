use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use std::io::Cursor;
use std::sync::{mpsc, Arc, Mutex};
use std::thread;

pub struct Recorder {
    samples: Arc<Mutex<Vec<f32>>>,
    sample_rate: u32,
    stop_tx: Option<mpsc::Sender<()>>,
    done_rx: Option<mpsc::Receiver<()>>,
    /// Offset into `samples` returned by the last `pull_pcm16_chunk`
    /// call. Reset on each `start()`. Lets the JS-side WS streamer pull
    /// "what's new since last poll" without re-sending old audio.
    pull_offset: usize,
}

impl Recorder {
    pub fn new() -> Self {
        Self {
            samples: Arc::new(Mutex::new(Vec::new())),
            sample_rate: 48_000,
            stop_tx: None,
            done_rx: None,
            pull_offset: 0,
        }
    }

    pub fn is_recording(&self) -> bool {
        self.stop_tx.is_some()
    }

    pub fn start(&mut self) -> Result<(), String> {
        if self.is_recording() {
            return Err("already recording".into());
        }
        self.samples.lock().unwrap().clear();
        self.pull_offset = 0;

        let samples = self.samples.clone();
        let (stop_tx, stop_rx) = mpsc::channel::<()>();
        let (ready_tx, ready_rx) = mpsc::channel::<Result<u32, String>>();
        let (done_tx, done_rx) = mpsc::channel::<()>();

        thread::spawn(move || {
            let host = cpal::default_host();
            let device = match host.default_input_device() {
                Some(d) => d,
                None => {
                    let _ = ready_tx.send(Err("no input device".into()));
                    return;
                }
            };
            let config = match device.default_input_config() {
                Ok(c) => c,
                Err(e) => {
                    let _ = ready_tx.send(Err(e.to_string()));
                    return;
                }
            };
            let sr = config.sample_rate().0;
            let channels = config.channels() as usize;
            let err_fn = |err| eprintln!("cpal stream error: {err}");

            let stream_result = match config.sample_format() {
                cpal::SampleFormat::F32 => {
                    let samples = samples.clone();
                    device.build_input_stream(
                        &config.into(),
                        move |data: &[f32], _: &_| {
                            let mut buf = samples.lock().unwrap();
                            for frame in data.chunks(channels) {
                                let s: f32 =
                                    frame.iter().copied().sum::<f32>() / channels as f32;
                                buf.push(s);
                            }
                        },
                        err_fn,
                        None,
                    )
                }
                cpal::SampleFormat::I16 => {
                    let samples = samples.clone();
                    device.build_input_stream(
                        &config.into(),
                        move |data: &[i16], _: &_| {
                            let mut buf = samples.lock().unwrap();
                            for frame in data.chunks(channels) {
                                let s: f32 = frame
                                    .iter()
                                    .map(|&x| x as f32 / i16::MAX as f32)
                                    .sum::<f32>()
                                    / channels as f32;
                                buf.push(s);
                            }
                        },
                        err_fn,
                        None,
                    )
                }
                cpal::SampleFormat::U16 => {
                    let samples = samples.clone();
                    device.build_input_stream(
                        &config.into(),
                        move |data: &[u16], _: &_| {
                            let mut buf = samples.lock().unwrap();
                            for frame in data.chunks(channels) {
                                let s: f32 = frame
                                    .iter()
                                    .map(|&x| (x as f32 - 32768.0) / 32768.0)
                                    .sum::<f32>()
                                    / channels as f32;
                                buf.push(s);
                            }
                        },
                        err_fn,
                        None,
                    )
                }
                other => {
                    let _ = ready_tx.send(Err(format!("unsupported sample format: {other:?}")));
                    return;
                }
            };

            let stream = match stream_result {
                Ok(s) => s,
                Err(e) => {
                    let _ = ready_tx.send(Err(e.to_string()));
                    return;
                }
            };

            if let Err(e) = stream.play() {
                let _ = ready_tx.send(Err(e.to_string()));
                return;
            }

            let _ = ready_tx.send(Ok(sr));
            let _ = stop_rx.recv();
            drop(stream);
            let _ = done_tx.send(());
        });

        match ready_rx
            .recv_timeout(std::time::Duration::from_secs(3))
            .map_err(|e| e.to_string())?
        {
            Ok(sr) => {
                self.sample_rate = sr;
                self.stop_tx = Some(stop_tx);
                self.done_rx = Some(done_rx);
                Ok(())
            }
            Err(e) => Err(e),
        }
    }

    /// Encode the current buffer as WAV without stopping the recording.
    /// Used for incremental "live preview" transcription while the user speaks.
    pub fn snapshot_wav(&self) -> Result<Vec<u8>, String> {
        let samples = self.samples.lock().unwrap().clone();
        write_wav(&samples, self.sample_rate)
    }

    /// Like `snapshot_wav` but encodes only the most recent `seconds` of
    /// audio. Used by the live-preview ticker to keep payload size bounded
    /// (and OpenAI latency low) on long recordings: re-transcribing 30 s
    /// of audio every tick is much slower than re-transcribing the most
    /// recent ~5 s window. Final transcription on stop still uses the
    /// full buffer via `stop()`.
    pub fn snapshot_recent_wav(&self, seconds: u32) -> Result<Vec<u8>, String> {
        let buf = self.samples.lock().unwrap();
        let want = (self.sample_rate as usize) * (seconds as usize);
        let start = buf.len().saturating_sub(want);
        let recent = buf[start..].to_vec();
        drop(buf);
        write_wav(&recent, self.sample_rate)
    }

    /// Returns new mic samples since the last call, downsampled to
    /// 16 kHz mono PCM16 little-endian. Used by the streaming
    /// /transcribe-stream WS path on the JS side: poll every ~100 ms,
    /// forward the bytes verbatim as binary frames.
    ///
    /// Implementation: input is mono f32 at the device sample rate
    /// (typically 48 kHz). We do a naive integer-ratio downsample —
    /// pick every Nth sample where N = sample_rate / 16000. Acceptable
    /// for speech; OpenAI's Realtime model is robust to this. Returns
    /// an empty Vec when no new samples are available.
    pub fn pull_pcm16_16k_chunk(&mut self) -> Vec<u8> {
        let buf = self.samples.lock().unwrap();
        if self.pull_offset >= buf.len() {
            return Vec::new();
        }
        let new = &buf[self.pull_offset..];
        let new_len = new.len();
        // Integer-ratio downsample. If the device runs at e.g. 44.1 kHz
        // (not a clean multiple of 16 k) we'd need fractional resampling
        // for top quality, but speech transcription tolerates the small
        // skew from `step = (sr / 16000).max(1)`.
        let step = (self.sample_rate as usize / 16_000).max(1);
        let mut out = Vec::with_capacity(new_len / step * 2);
        let mut i = 0;
        while i < new.len() {
            let s = new[i].clamp(-1.0, 1.0);
            let v = (s * 32767.0) as i16;
            out.extend_from_slice(&v.to_le_bytes());
            i += step;
        }
        // Move offset by samples consumed (= the part we read), not by
        // output bytes. Even when step > 1 we've inspected `new_len`.
        self.pull_offset += new_len;
        out
    }

    pub fn stop(&mut self) -> Result<Vec<u8>, String> {
        let tx = self.stop_tx.take().ok_or("not recording")?;
        let done_rx = self.done_rx.take();
        let _ = tx.send(());
        if let Some(rx) = done_rx {
            let _ = rx.recv_timeout(std::time::Duration::from_secs(2));
        }
        let samples = self.samples.lock().unwrap().clone();
        write_wav(&samples, self.sample_rate)
    }
}

fn write_wav(samples: &[f32], sample_rate: u32) -> Result<Vec<u8>, String> {
    let spec = hound::WavSpec {
        channels: 1,
        sample_rate,
        bits_per_sample: 16,
        sample_format: hound::SampleFormat::Int,
    };
    let mut cursor = Cursor::new(Vec::new());
    {
        let mut writer = hound::WavWriter::new(&mut cursor, spec).map_err(|e| e.to_string())?;
        for &s in samples {
            let v = (s.clamp(-1.0, 1.0) * 32767.0) as i16;
            writer.write_sample(v).map_err(|e| e.to_string())?;
        }
        writer.finalize().map_err(|e| e.to_string())?;
    }
    Ok(cursor.into_inner())
}
