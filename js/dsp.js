/* Crunchi — the crunch engine.
 *
 * All DSP happens on the whole track: no clip previews, no 30-second limits.
 * Order of operations:
 *   fade edges -> drive/saturate -> bitcrush -> sample-rate crush ->
 *   tone filter -> remove DC -> normalize -> lossy codec passes
 */
(() => {
  'use strict';

  const DEFAULT_SETTINGS = {
    bits: 6,
    rate: 11025,
    kbps: 24,
    drive: 10,
    tone: 14000,
    passes: 1,
    mono: false,
    engine: 'mp3'
  };

  const PRESETS = {
    toast: {
      label: 'TOAST',
      settings: {
        bits: 10, rate: 22050, kbps: 64, drive: 4,
        tone: 18000, passes: 1, mono: false
      }
    },
    crunchy: {
      label: 'CRUNCHY',
      settings: {
        bits: 6, rate: 11025, kbps: 24, drive: 10,
        tone: 14000, passes: 1, mono: false
      }
    },
    fried: {
      label: 'DEEP FRIED',
      settings: {
        bits: 4, rate: 5512, kbps: 12, drive: 16,
        tone: 10000, passes: 2, mono: true
      }
    },
    demolished: {
      label: 'DEMOLISHED',
      settings: {
        bits: 2, rate: 2756, kbps: 8, drive: 24,
        tone: 7000, passes: 3, mono: true
      }
    }
  };

  let decodeContext = null;

  const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
  const yieldToUi = () => new Promise((resolve) => setTimeout(resolve, 0));

  function abortError() {
    const error = new Error('Crunch cancelled');
    error.name = 'AbortError';
    return error;
  }

  function sanitize(settings = {}) {
    const merged = { ...DEFAULT_SETTINGS, ...settings };
    const engine = merged.engine === 'opus' || merged.engine === '3gp' ? merged.engine : 'mp3';
    return {
      bits: Math.round(clamp(Number(merged.bits) || 6, 2, 16)),
      rate: Math.round(clamp(Number(merged.rate) || 11025, 500, 44100)),
      kbps: Math.round(clamp(Number(merged.kbps) || 24, 6, 128)),
      drive: clamp(Number(merged.drive) || 0, 0, 36),
      tone: Math.round(clamp(Number(merged.tone) || 14000, 500, 20000)),
      passes: Math.round(clamp(Number(merged.passes) || 1, 1, 4)),
      mono: Boolean(merged.mono),
      engine
    };
  }

  function settingsKey(settings) {
    const s = sanitize(settings);
    return [s.bits, s.rate, s.kbps, s.drive, s.tone, s.passes, s.mono ? 1 : 0, s.engine].join('|');
  }

  function channelsFromAudioBuffer(buffer, mono) {
    const sourceChannels = buffer.numberOfChannels;
    if (mono || sourceChannels === 1) {
      const mixed = new Float32Array(buffer.length);
      for (let channel = 0; channel < sourceChannels; channel += 1) {
        const data = buffer.getChannelData(channel);
        for (let i = 0; i < mixed.length; i += 1) {
          mixed[i] += data[i] / sourceChannels;
        }
      }
      return [mixed];
    }

    const out = [];
    const count = Math.min(2, sourceChannels);
    for (let channel = 0; channel < count; channel += 1) {
      out.push(new Float32Array(buffer.getChannelData(channel)));
    }
    return out;
  }

  function fitChannels(channels, frames, targetChannelCount) {
    const fitted = [];
    for (let channel = 0; channel < targetChannelCount; channel += 1) {
      const source = channels[Math.min(channel, channels.length - 1)];
      const data = new Float32Array(frames);
      if (source) {
        data.set(source.subarray(0, Math.min(frames, source.length)));
      }
      fitted.push(data);
    }
    return fitted;
  }

  function fadeEdges(channels, sampleRate, seconds) {
    const length = channels[0].length;
    const fadeFrames = Math.min(Math.floor(sampleRate * seconds), Math.floor(length / 2));
    if (fadeFrames < 2) return;

    for (const data of channels) {
      for (let i = 0; i < fadeFrames; i += 1) {
        const gain = i / fadeFrames;
        data[i] *= gain;
        data[length - 1 - i] *= gain;
      }
    }
  }

  function applyDrive(channels, driveDb) {
    const gain = Math.pow(10, driveDb / 20);
    for (const data of channels) {
      for (let i = 0; i < data.length; i += 1) {
        data[i] = Math.tanh(data[i] * gain * 1.15);
      }
    }
  }

  function bitCrush(channels, bits) {
    const levels = Math.pow(2, bits);
    for (const data of channels) {
      for (let i = 0; i < data.length; i += 1) {
        data[i] = Math.round(data[i] * levels) / levels;
      }
    }
  }

  function downsampleHold(channels, sampleRate, targetRate) {
    if (targetRate >= sampleRate) return;

    // Read the input sample at the start of each target-rate bucket, then hold
    // it. This keeps the track's duration and pitch while adding aliasing.
    const ratio = targetRate / sampleRate;
    const step = 1 / ratio;
    const length = channels[0].length;
    const scratch = new Float32Array(length);

    for (const data of channels) {
      scratch.set(data);

      for (let i = 0; i < length; i += 1) {
        const bucket = Math.floor(i * ratio);
        const index = Math.min(length - 1, Math.floor(bucket * step));
        data[i] = scratch[index];
      }
    }
  }

  function toneFilter(channels, sampleRate, cutoff) {
    if (cutoff >= sampleRate * 0.46) return;

    const coefficient = 1 - Math.exp((-2 * Math.PI * cutoff) / sampleRate);
    for (const data of channels) {
      let first = 0;
      let second = 0;
      for (let i = 0; i < data.length; i += 1) {
        first += coefficient * (data[i] - first);
        second += coefficient * (first - second);
        data[i] = second;
      }
    }
  }

  function removeDC(channels) {
    for (const data of channels) {
      let sum = 0;
      for (let i = 0; i < data.length; i += 1) sum += data[i];
      const mean = sum / data.length;
      if (Math.abs(mean) > 1e-7) {
        for (let i = 0; i < data.length; i += 1) data[i] -= mean;
      }
    }
  }

  function normalize(channels, targetPeak) {
    let peak = 0;
    for (const data of channels) {
      for (let i = 0; i < data.length; i += 1) {
        const value = Math.abs(data[i]);
        if (value > peak) peak = value;
      }
    }
    if (peak < 1e-8) return;

    const gain = targetPeak / peak;
    for (const data of channels) {
      for (let i = 0; i < data.length; i += 1) data[i] *= gain;
    }
  }

  function encodeMp3(channels, sampleRate, kbps, onChunk, checkAbort) {
    if (!window.lamejs || !window.lamejs.Mp3Encoder) {
      return Promise.reject(new Error('The built-in MP3 encoder failed to load.'));
    }

    const encoder = new window.lamejs.Mp3Encoder(channels.length, sampleRate, kbps);
    const frames = channels[0].length;

    // lamejs corrupts input larger than ~2 MP3 frames, so feed it one frame
    // at a time. Yield to the UI roughly every 0.8 s of 44.1 kHz audio.
    const blockSize = 1152;
    const yieldEvery = blockSize * 32;
    const leftScratch = new Int16Array(blockSize);
    const rightScratch = channels.length > 1 ? new Int16Array(blockSize) : null;
    const parts = [];
    let totalBytes = 0;
    let sinceYield = 0;

    return (async () => {
      for (let start = 0; start < frames; start += blockSize) {
        const end = Math.min(frames, start + blockSize);
        const count = end - start;
        const left = channels[0];
        const right = channels.length > 1 ? channels[1] : null;

        for (let i = 0; i < count; i += 1) {
          let value = left[start + i];
          value = value < -1 ? -1 : value > 1 ? 1 : value;
          leftScratch[i] = value < 0 ? value * 0x8000 : value * 0x7fff;

          if (right) {
            let r = right[start + i];
            r = r < -1 ? -1 : r > 1 ? 1 : r;
            rightScratch[i] = r < 0 ? r * 0x8000 : r * 0x7fff;
          }
        }

        const leftView = leftScratch.subarray(0, count);
        const encoded = right
          ? encoder.encodeBuffer(leftView, rightScratch.subarray(0, count))
          : encoder.encodeBuffer(leftView);

        if (encoded.length) {
          parts.push(new Uint8Array(encoded));
          totalBytes += encoded.length;
        }

        sinceYield += count;

        if (sinceYield >= yieldEvery || end === frames) {
          if (checkAbort) checkAbort();
          if (onChunk) onChunk(end / frames);
          sinceYield = 0;
          await yieldToUi();
        }
      }

      const tail = encoder.flush();
      if (tail.length) {
        parts.push(new Uint8Array(tail));
        totalBytes += tail.length;
      }

      const output = new Uint8Array(totalBytes);
      let offset = 0;
      for (const part of parts) {
        output.set(part, offset);
        offset += part.length;
      }
      return output;
    })();
  }

  function getDecodeContext(sampleRate) {
    if (!decodeContext || decodeContext.sampleRate !== sampleRate) {
      decodeContext = new OfflineAudioContext(1, 1, sampleRate);
    }
    return decodeContext;
  }

  function decodeMp3(bytes, sampleRate) {
    const copy = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    return getDecodeContext(sampleRate).decodeAudioData(copy);
  }

  function interleaveInt16(channels) {
    const channelCount = channels.length;
    const frames = channels[0].length;
    const output = new Int16Array(frames * channelCount);

    for (let channel = 0; channel < channelCount; channel += 1) {
      const data = channels[channel];
      for (let i = 0; i < frames; i += 1) {
        let value = data[i];
        value = value < -1 ? -1 : value > 1 ? 1 : value;
        output[i * channelCount + channel] = value < 0 ? value * 0x8000 : value * 0x7fff;
      }
    }
    return output;
  }

  function deinterleaveInt16(pcm, channelCount, frames) {
    const channels = [];
    const safeChannels = channelCount === 1 ? 1 : 2;
    const availableFrames = Math.min(frames, Math.floor(pcm.length / safeChannels));

    for (let channel = 0; channel < safeChannels; channel += 1) {
      const data = new Float32Array(availableFrames);
      for (let i = 0; i < availableFrames; i += 1) {
        data[i] = pcm[i * safeChannels + channel] / 32768;
      }
      channels.push(data);
    }
    return channels;
  }

  function crunchScore(settings) {
    const s = sanitize(settings);
    const bits = clamp((12 - s.bits) / 10, 0, 1);
    const rate = clamp(1 - (s.rate - 800) / (22050 - 800), 0, 1);
    const kbps = clamp(1 - (s.kbps - 8) / (128 - 8), 0, 1);
    const drive = clamp(s.drive / 24, 0, 1);
    const passes = clamp((s.passes - 1) / 2, 0, 1);
    const codec = s.engine === '3gp' ? 0.1 : 0;
    const score = bits * 0.32 + rate * 0.26 + kbps * 0.26 + drive * 0.1 + passes * 0.06 + codec;
    return Math.round(clamp(score, 0.02, 1) * 100);
  }

  function crunchLabel(score) {
    if (score < 30) return 'LIGHT TOAST';
    if (score < 50) return 'TOASTY';
    if (score < 68) return 'CRUNCHY';
    if (score < 84) return 'DEEP FRIED';
    if (score < 95) return 'SEVERELY CRUNCHED';
    return 'TOTAL DEMOLITION';
  }

  /**
   * Crunch an entire AudioBuffer.
   * @param {AudioBuffer} buffer
   * @param {object} settings
   * @param {object} options
   * @param {(value:number,label:string)=>void} options.onProgress
   * @param {AbortSignal} options.signal
   * @param {(channels:Float32Array[],sampleRate:number,kbps:number)=>Promise<{bytes:Uint8Array,channels:Float32Array[]}>} options.opusEncode
   * @param {(channels:Float32Array[],sampleRate:number,kbps:number)=>Promise<{bytes:Uint8Array,channels:Float32Array[]}>} options.threeGpEncode
   */
  async function process(buffer, settings, options = {}) {
    const opts = sanitize(settings);
    const sampleRate = buffer.sampleRate;
    const frames = buffer.length;
    const report = (value, label) => {
      if (options.onProgress) options.onProgress(clamp(value, 0, 1), label);
    };
    const checkAbort = () => {
      if (options.signal && options.signal.aborted) throw abortError();
    };

    report(0.01, 'PREPARING');
    await yieldToUi();
    checkAbort();

    let channels = channelsFromAudioBuffer(buffer, opts.mono);
    const channelCount = channels.length;

    fadeEdges(channels, sampleRate, 0.004);

    report(0.04, 'DRIVING');
    applyDrive(channels, opts.drive);
    await yieldToUi();
    checkAbort();

    report(0.08, 'CRUSHING BITS');
    bitCrush(channels, opts.bits);

    report(0.11, 'DOWNSAMPLING');
    downsampleHold(channels, sampleRate, opts.rate);

    report(0.14, 'TAMING FIZZ');
    toneFilter(channels, sampleRate, opts.tone);
    removeDC(channels);
    normalize(channels, 0.86);

    let engine = opts.engine;
    if (engine === 'opus' && typeof options.opusEncode !== 'function') {
      engine = 'mp3';
    }
    if (engine === '3gp' && typeof options.threeGpEncode !== 'function') {
      engine = 'mp3';
    }

    let codecBytes = null;
    const passes = opts.passes;

    for (let pass = 0; pass < passes; pass += 1) {
      checkAbort();
      const base = 0.16 + (pass / passes) * 0.8;
      const span = 0.8 / passes;
      const engineLabel = engine === 'opus' ? 'OPUS' : engine === '3gp' ? '3GP' : 'MP3';
      report(base, `${engineLabel} PASS ${pass + 1}/${passes}`);

      if (engine === 'opus' || engine === '3gp') {
        const encode = engine === 'opus' ? options.opusEncode : options.threeGpEncode;
        const encoded = await encode(channels, sampleRate, opts.kbps);
        checkAbort();
        codecBytes = encoded.bytes;
        channels = fitChannels(encoded.channels, frames, channelCount);
        report(base + span * 0.85, 'DECODED');
      } else {
        const encoded = await encodeMp3(
          channels,
          sampleRate,
          opts.kbps,
          (progress) => report(base + span * 0.78 * progress, `ENCODING ${Math.round(progress * 100)}%`),
          checkAbort
        );
        codecBytes = encoded;
        report(base + span * 0.82, 'DECODING');
        const decoded = await decodeMp3(encoded, sampleRate);
        checkAbort();
        channels = fitChannels(channelsFromAudioBuffer(decoded, false), frames, channelCount);
        report(base + span * 0.9, 'DECODED');
      }

      await yieldToUi();
    }

    fadeEdges(channels, sampleRate, 0.008);
    normalize(channels, 0.94);
    report(1, 'DONE');

    return {
      channels,
      sampleRate,
      codecBytes,
      codecExt: engine === 'opus' ? 'opus' : engine === '3gp' ? '3gp' : 'mp3',
      settings: { ...opts, engine }
    };
  }

  window.CrunchiDSP = {
    DEFAULT_SETTINGS,
    PRESETS,
    process,
    sanitize,
    settingsKey,
    crunchScore,
    crunchLabel,
    interleaveInt16,
    deinterleaveInt16,
    fitChannels
  };
})();
