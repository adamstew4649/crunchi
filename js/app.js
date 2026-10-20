/* Crunchi — renderer / UI */
(() => {
  'use strict';

  const DSP = window.CrunchiDSP;
  const WAV = window.CrunchiWav;
  const { DEFAULT_SETTINGS, PRESETS } = DSP;

  const $ = (id) => document.getElementById(id);

  const els = {
    openBtn: $('openBtn'),
    replaceBtn: $('replaceBtn'),
    sourceMeta: $('sourceMeta'),
    sourceWaveWrap: $('sourceWaveWrap'),
    sourceCanvas: $('sourceCanvas'),
    sourceEmpty: $('sourceEmpty'),
    sourcePlayhead: $('sourcePlayhead'),
    fileName: $('fileName'),
    fileInfo: $('fileInfo'),

    presets: $('presets'),
    bits: $('bits'),
    bitsOut: $('bitsOut'),
    rate: $('rate'),
    rateOut: $('rateOut'),
    kbps: $('kbps'),
    kbpsOut: $('kbpsOut'),
    drive: $('drive'),
    driveOut: $('driveOut'),
    tone: $('tone'),
    toneOut: $('toneOut'),
    mono: $('mono'),
    passes: $('passes'),
    engine: $('engine'),
    autoPreview: $('autoPreview'),
    crunchBtn: $('crunchBtn'),
    crunchBtnLabel: $('crunchBtnLabel'),
    progress: $('progress'),
    progressFill: $('progressFill'),
    progressStage: $('progressStage'),
    progressPct: $('progressPct'),
    meterBars: $('meterBars'),
    meterLabel: $('meterLabel'),

    resultPanel: document.querySelector('.result-panel'),
    resultState: $('resultState'),
    resultWaveWrap: $('resultWaveWrap'),
    resultCanvas: $('resultCanvas'),
    resultEmpty: $('resultEmpty'),
    resultPlayhead: $('resultPlayhead'),
    playBtn: $('playBtn'),
    playIcon: $('playIcon'),
    timeReadout: $('timeReadout'),

    statCodec: $('statCodec'),
    statBits: $('statBits'),
    statRate: $('statRate'),
    statSize: $('statSize'),

    downloadCodec: $('downloadCodec'),
    downloadCodecLabel: $('downloadCodecLabel'),
    codecSize: $('codecSize'),
    downloadWav: $('downloadWav'),

    ffmpegStatus: $('ffmpegStatus'),
    versionLabel: $('versionLabel'),
    toast: $('toast')
  };

  const abSource = document.querySelector('.ab-switch button[data-audio="source"]');
  const abResult = document.querySelector('.ab-switch button[data-audio="result"]');
  const opusOption = document.querySelector('#engine option[value="opus"]');

  const PLAY_PATH = 'M8 5v14l11-7z';
  const PAUSE_PATH = 'M6 5h4v14H6zM14 5h4v14h-4z';
  const SOURCE_COLORS = ['rgba(148, 126, 105, 0.9)', 'rgba(97, 83, 69, 0.62)'];
  const RESULT_COLORS = ['#ff6a00', '#ffc247'];
  const METER_BARS = 16;
  const MAX_SECONDS = 30 * 60;

  const state = {
    sourceBuffer: null,
    sourceName: '',
    sourceBytes: 0,
    sourcePeaks: null,
    sourcePeak: 0,
    resultBuffer: null,
    resultBytes: null,
    resultExt: 'mp3',
    resultSettings: null,
    resultPeaks: null,
    resultPeak: 0,
    settings: { ...DEFAULT_SETTINGS },
    activeTab: 'source',
    playing: false,
    playOffset: 0,
    startedAt: 0,
    playNode: null,
    playGain: null,
    playToken: 0,
    raf: 0,
    busy: false,
    renderToken: 0,
    renderAbort: null,
    renderTimer: 0,
    renderKey: null,
    loadToken: 0,
    autoPreview: true,
    ffmpeg: false,
    dialogOpen: false,
    saving: false,
    lastTimeText: '',
    dragDepth: 0
  };

  let audioCtx = null;

  function getCtx() {
    if (!audioCtx) {
      try {
        audioCtx = new AudioContext({ sampleRate: 44100, latencyHint: 'interactive' });
      } catch (error) {
        audioCtx = new AudioContext();
      }
    }
    return audioCtx;
  }

  function ensureRunning() {
    const ctx = getCtx();
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
  }

  /* ---------------------------------------------------------------- */
  /* little helpers                                                    */
  /* ---------------------------------------------------------------- */

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  function formatBytes(bytes) {
    if (!Number.isFinite(bytes) || bytes <= 0) return '—';
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) {
      return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
    }
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  function formatRate(rate) {
    return `${(rate / 1000).toFixed(1)} kHz`;
  }

  function formatTime(seconds) {
    const total = Math.max(0, Math.floor(seconds || 0));
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const secs = total % 60;
    if (hours > 0) {
      return `${hours}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
    }
    return `${minutes}:${String(secs).padStart(2, '0')}`;
  }

  let toastTimer = 0;
  function toast(message, duration = 4200) {
    clearTimeout(toastTimer);
    els.toast.textContent = message;
    els.toast.classList.add('show');
    toastTimer = setTimeout(() => els.toast.classList.remove('show'), duration);
  }

  function isAudioFile(file) {
    if (!file) return false;
    if (file.type && file.type.startsWith('audio/')) return true;
    return /\.(wav|mp3|flac|m4a|aac|ogg|oga|opus|aif|aiff|caf|webm|mp4)$/i.test(file.name || '');
  }

  function baseName(name) {
    return String(name || 'track').replace(/\.[^.]+$/, '');
  }

  /* ---------------------------------------------------------------- */
  /* waveforms                                                         */
  /* ---------------------------------------------------------------- */

  function computePeaks(buffer) {
    const frames = buffer.length;
    const channels = Math.min(2, buffer.numberOfChannels);
    const bins = Math.min(1400, Math.max(1, frames));
    const block = Math.max(1, Math.floor(frames / bins));
    const peaks = new Float32Array(bins * 2);
    const data = [];

    for (let channel = 0; channel < channels; channel += 1) {
      data.push(buffer.getChannelData(channel));
    }

    let peak = 0;

    for (let bin = 0; bin < bins; bin += 1) {
      let min = 0;
      let max = 0;
      const start = bin * block;
      const end = Math.min(frames, start + block);
      const stride = Math.max(1, Math.floor((end - start) / 48));

      for (let channel = 0; channel < channels; channel += 1) {
        const samples = data[channel];
        for (let i = start; i < end; i += stride) {
          const value = samples[i];
          if (value < min) min = value;
          if (value > max) max = value;
          const absolute = Math.abs(value);
          if (absolute > peak) peak = absolute;
        }
      }

      peaks[bin * 2] = min;
      peaks[bin * 2 + 1] = max;
    }

    return { peaks, peak };
  }

  function drawWave(canvas, peaks, colors) {
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const width = Math.max(1, Math.round(rect.width));
    const height = Math.max(1, Math.round(rect.height));
    const dpr = Math.min(2, window.devicePixelRatio || 1);

    if (canvas.width !== width * dpr || canvas.height !== height * dpr) {
      canvas.width = width * dpr;
      canvas.height = height * dpr;
    }

    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);

    const middle = height / 2;

    if (!peaks || peaks.length < 2) {
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.05)';
      ctx.beginPath();
      ctx.moveTo(0, middle + 0.5);
      ctx.lineTo(width, middle + 0.5);
      ctx.stroke();
      return;
    }

    const bins = peaks.length / 2;
    const amplitude = middle * 0.92;

    ctx.beginPath();
    for (let x = 0; x < width; x += 1) {
      const bin = Math.min(bins - 1, Math.floor((x / width) * bins));
      const y = middle - Math.max(0, peaks[bin * 2 + 1]) * amplitude;
      if (x === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    for (let x = width - 1; x >= 0; x -= 1) {
      const bin = Math.min(bins - 1, Math.floor((x / width) * bins));
      const y = middle - Math.min(0, peaks[bin * 2]) * amplitude;
      ctx.lineTo(x, y);
    }
    ctx.closePath();

    const gradient = ctx.createLinearGradient(0, 0, width, 0);
    gradient.addColorStop(0, colors[0]);
    gradient.addColorStop(1, colors[1]);
    ctx.fillStyle = gradient;
    ctx.fill();

    ctx.strokeStyle = 'rgba(255, 255, 255, 0.06)';
    ctx.beginPath();
    ctx.moveTo(0, middle + 0.5);
    ctx.lineTo(width, middle + 0.5);
    ctx.stroke();
  }

  function redrawAll() {
    drawWave(els.sourceCanvas, state.sourcePeaks, SOURCE_COLORS);
    drawWave(els.resultCanvas, state.resultPeaks, RESULT_COLORS);
  }

  /* ---------------------------------------------------------------- */
  /* playback                                                          */
  /* ---------------------------------------------------------------- */

  function activeBuffer() {
    return state.activeTab === 'result' ? state.resultBuffer : state.sourceBuffer;
  }

  function currentPosition() {
    if (!state.playing) return state.playOffset;
    const buffer = activeBuffer();
    if (!buffer) return 0;
    return clamp(getCtx().currentTime - state.startedAt, 0, buffer.duration);
  }

  function playbackGain() {
    const peak = state.activeTab === 'result' ? state.resultPeak : state.sourcePeak;
    return Math.min(1.5, 0.9 / Math.max(0.03, peak || 0.9));
  }

  function updateTimeReadout() {
    const buffer = activeBuffer();
    const duration = buffer ? buffer.duration : 0;
    const text = `${formatTime(currentPosition())} / ${formatTime(duration)}`;
    if (text !== state.lastTimeText) {
      state.lastTimeText = text;
      els.timeReadout.textContent = text;
    }
  }

  function updatePlayheads() {
    const buffer = activeBuffer();
    const duration = buffer ? buffer.duration : 0;
    const position = currentPosition();
    const ratio = duration > 0 ? clamp(position / duration, 0, 1) : 0;
    const show = Boolean(buffer) && (state.playing || position > 0.01);
    const sourceActive = state.activeTab === 'source' && Boolean(state.sourceBuffer);
    const resultActive = state.activeTab === 'result' && Boolean(state.resultBuffer);

    els.sourcePlayhead.style.left = `${ratio * 100}%`;
    els.sourcePlayhead.style.opacity = show && sourceActive ? '1' : '0';
    els.resultPlayhead.style.left = `${ratio * 100}%`;
    els.resultPlayhead.style.opacity = show && resultActive ? '1' : '0';
  }

  function updateTransport() {
    const buffer = activeBuffer();
    const hasBuffer = Boolean(buffer);

    els.playBtn.disabled = !hasBuffer;
    els.playIcon.setAttribute('d', state.playing ? PAUSE_PATH : PLAY_PATH);
    els.playBtn.setAttribute('aria-label', state.playing ? 'Pause' : 'Play');

    abSource.classList.toggle('active', state.activeTab === 'source');
    abResult.classList.toggle('active', state.activeTab === 'result');
    abResult.disabled = !state.resultBuffer;

    updateTimeReadout();
    updatePlayheads();
  }

  function stopPlayback(resetOffset) {
    state.playToken += 1;
    cancelAnimationFrame(state.raf);

    if (state.playNode) {
      state.playNode.onended = null;
      try {
        state.playNode.stop();
      } catch (error) {
        /* already stopped */
      }
      try {
        state.playNode.disconnect();
      } catch (error) {
        /* already disconnected */
      }
      if (state.playGain) {
        try {
          state.playGain.disconnect();
        } catch (error) {
          /* already disconnected */
        }
      }
    }

    state.playNode = null;
    state.playGain = null;
    state.playing = false;
    if (resetOffset) state.playOffset = 0;
  }

  function tick() {
    if (!state.playing) return;
    const buffer = activeBuffer();
    if (!buffer) return;

    const position = getCtx().currentTime - state.startedAt;
    if (position >= buffer.duration) {
      state.playing = false;
      state.playOffset = 0;
      state.playNode = null;
      state.playGain = null;
      updateTransport();
      return;
    }

    state.playOffset = position;
    updateTimeReadout();
    updatePlayheads();
    state.raf = requestAnimationFrame(tick);
  }

  function play() {
    const buffer = activeBuffer();
    if (!buffer) return;

    ensureRunning();
    stopPlayback(false);

    if (state.playOffset >= buffer.duration - 0.02) state.playOffset = 0;

    const ctx = getCtx();
    const node = ctx.createBufferSource();
    const gain = ctx.createGain();
    node.buffer = buffer;
    gain.gain.value = playbackGain();
    node.connect(gain);
    gain.connect(ctx.destination);

    const offset = clamp(state.playOffset, 0, Math.max(0, buffer.duration - 0.01));
    node.start(0, offset);

    state.playNode = node;
    state.playGain = gain;
    state.startedAt = ctx.currentTime - offset;
    state.playing = true;

    const token = ++state.playToken;
    node.onended = () => {
      if (state.playToken !== token) return;
      state.playing = false;
      state.playOffset = 0;
      state.playNode = null;
      state.playGain = null;
      updateTransport();
    };

    updateTransport();
    cancelAnimationFrame(state.raf);
    state.raf = requestAnimationFrame(tick);
  }

  function pause() {
    if (!state.playing) return;
    state.playOffset = currentPosition();
    stopPlayback(false);
    updateTransport();
  }

  function togglePlay() {
    if (state.playing) pause();
    else play();
  }

  function setActive(tab) {
    const target = tab === 'result' ? state.resultBuffer : state.sourceBuffer;
    if (!target || state.activeTab === tab) return;

    const wasPlaying = state.playing;
    const position = currentPosition();

    if (wasPlaying) stopPlayback(false);
    state.activeTab = tab;
    state.playOffset = clamp(position, 0, Math.max(0, target.duration - 0.02));

    if (wasPlaying) play();
    else updateTransport();
  }

  function ratioFromEvent(event, element) {
    const rect = element.getBoundingClientRect();
    if (rect.width <= 0) return 0;
    return clamp((event.clientX - rect.left) / rect.width, 0, 0.999);
  }

  function seekTo(tab, ratio) {
    const target = tab === 'result' ? state.resultBuffer : state.sourceBuffer;
    if (!target) return;

    const wasPlaying = state.playing;
    if (wasPlaying) stopPlayback(false);

    state.activeTab = tab;
    state.playOffset = ratio * target.duration;

    if (wasPlaying) play();
    else updateTransport();
  }

  /* ---------------------------------------------------------------- */
  /* settings UI                                                       */
  /* ---------------------------------------------------------------- */

  const CONTROL_UI = {
    bits: {
      el: els.bits,
      out: els.bitsOut,
      format: (value) => `${value} bit`
    },
    rate: {
      el: els.rate,
      out: els.rateOut,
      format: (value) => formatRate(value)
    },
    kbps: {
      el: els.kbps,
      out: els.kbpsOut,
      format: (value) => `${value} kbps`
    },
    drive: {
      el: els.drive,
      out: els.driveOut,
      format: (value) => (value === 0 ? '0 dB' : `+${value} dB`)
    },
    tone: {
      el: els.tone,
      out: els.toneOut,
      format: (value) => formatRate(value)
    }
  };

  function updateControlUI(key) {
    const ui = CONTROL_UI[key];
    if (!ui) return;
    const value = Number(state.settings[key]);
    const min = Number(ui.el.min);
    const max = Number(ui.el.max);
    const percent = max > min ? ((value - min) / (max - min)) * 100 : 0;

    ui.el.value = value;
    ui.out.textContent = ui.format(value);
    ui.el.style.setProperty('--p', `${clamp(percent, 0, 100)}%`);
  }

  function syncSettingsUI() {
    Object.keys(CONTROL_UI).forEach(updateControlUI);
    els.mono.checked = Boolean(state.settings.mono);
    els.passes.value = String(state.settings.passes);
    els.engine.value = state.settings.engine;
  }

  function soundKey(settings) {
    const value = DSP.sanitize(settings);
    return [value.bits, value.rate, value.kbps, value.drive, value.tone, value.passes, value.mono ? 1 : 0].join('|');
  }

  function updatePresetButtons() {
    const current = soundKey(state.settings);
    els.presets.querySelectorAll('button[data-preset]').forEach((button) => {
      const preset = PRESETS[button.dataset.preset];
      button.classList.toggle('active', Boolean(preset) && soundKey(preset.settings) === current);
    });
  }

  function buildMeter() {
    for (let i = 0; i < METER_BARS; i += 1) {
      const bar = document.createElement('i');
      bar.style.height = `${4 + (i / (METER_BARS - 1)) * 10}px`;
      els.meterBars.appendChild(bar);
    }
  }

  function updateMeter() {
    const score = DSP.crunchScore(state.settings);
    const lit = Math.round((score / 100) * METER_BARS);

    Array.from(els.meterBars.children).forEach((bar, index) => {
      bar.classList.toggle('on', index < lit);
      bar.classList.toggle('hot', index < lit && index >= METER_BARS - 4);
    });

    els.meterLabel.textContent = DSP.crunchLabel(score);
    els.meterLabel.title = `Crunch factor: ${score}/100`;
  }

  /* ---------------------------------------------------------------- */
  /* result + progress UI                                              */
  /* ---------------------------------------------------------------- */

  function setResultState(text, kind) {
    els.resultState.textContent = text;
    els.resultState.className = `state-badge${kind ? ` ${kind}` : ''}`;
  }

  function refreshResultState() {
    if (!state.resultBuffer) {
      setResultState('WAITING', '');
      return;
    }

    const current = DSP.settingsKey(state.settings);
    const stored = state.resultSettings ? DSP.settingsKey(state.resultSettings) : '';
    if (current === stored) setResultState('READY', 'ready');
    else setResultState('SETTINGS CHANGED', 'stale');
  }

  function updateProgress(value, label) {
    const percent = Math.round(clamp(value, 0, 1) * 100);
    els.progressFill.style.width = `${percent}%`;
    els.progressStage.textContent = label || 'CRUNCHING';
    els.progressPct.textContent = `${percent}%`;
    if (state.busy) setResultState(`CRUNCHING ${percent}%`, 'busy');
  }

  function setBusyUI(busy) {
    els.crunchBtn.classList.toggle('busy', busy);
    els.crunchBtn.disabled = busy || !state.sourceBuffer;
    els.crunchBtnLabel.textContent = busy
      ? 'CRUNCHING THE WHOLE TRACK…'
      : state.resultBuffer
        ? 'CRUNCH AGAIN'
        : 'CRUNCH IT';

    els.progress.hidden = !busy;
    els.resultPanel.classList.toggle('busy', busy);

    if (busy) {
      els.progressFill.style.width = '0%';
      els.progressStage.textContent = 'WARMING UP';
      els.progressPct.textContent = '0%';
      setResultState('CRUNCHING', 'busy');
    } else {
      refreshResultState();
    }
  }

  function resetResultUI() {
    state.resultBuffer = null;
    state.resultBytes = null;
    state.resultExt = 'mp3';
    state.resultSettings = null;
    state.resultPeaks = null;
    state.resultPeak = 0;

    els.resultEmpty.hidden = false;
    els.resultWaveWrap.classList.remove('has-audio');
    setResultState('WAITING', '');

    els.statCodec.textContent = '—';
    els.statBits.textContent = '—';
    els.statRate.textContent = '—';
    els.statSize.textContent = '—';

    els.downloadCodec.disabled = true;
    els.downloadWav.disabled = true;
    els.downloadCodecLabel.textContent = 'DOWNLOAD MP3';
    els.codecSize.textContent = '';
    els.resultPlayhead.style.opacity = '0';

    els.resultCanvas.getContext('2d').clearRect(0, 0, els.resultCanvas.width, els.resultCanvas.height);

    state.activeTab = 'source';
    updateTransport();
  }

  function updateResultUI(result) {
    els.resultEmpty.hidden = true;
    els.resultWaveWrap.classList.add('has-audio');
    setResultState('READY', 'ready');

    const settings = result.settings;
    const bytes = result.codecBytes ? result.codecBytes.length : 0;

    els.statCodec.textContent = `${result.codecExt.toUpperCase()} · ${settings.kbps} kbps`;
    els.statBits.textContent = `${settings.bits} bit`;
    els.statRate.textContent = formatRate(settings.rate);

    let sizeText = formatBytes(bytes);
    if (state.sourceBytes > 0 && bytes > 0) {
      const smaller = Math.round((1 - bytes / state.sourceBytes) * 100);
      if (smaller > 0) sizeText += ` · ${smaller}% smaller`;
    }
    els.statSize.textContent = sizeText;

    els.downloadCodec.disabled = false;
    els.downloadWav.disabled = false;
    els.downloadCodecLabel.textContent = `DOWNLOAD ${result.codecExt.toUpperCase()}`;
    els.codecSize.textContent = formatBytes(bytes);
    abResult.disabled = false;
  }

  function applyResult(audioBuffer, result) {
    const wasPlaying = state.playing;
    const previousTab = state.activeTab;
    const previousPosition = currentPosition();
    const hadResult = Boolean(state.resultBuffer);
    const resultWasActive = previousTab === 'result' && hadResult;

    if (resultWasActive) stopPlayback(false);

    state.resultBuffer = audioBuffer;
    state.resultBytes = result.codecBytes;
    state.resultExt = result.codecExt;
    state.resultSettings = { ...result.settings };

    const peaks = computePeaks(audioBuffer);
    state.resultPeaks = peaks.peaks;
    state.resultPeak = peaks.peak;

    if (resultWasActive) {
      state.activeTab = 'result';
      state.playOffset = clamp(previousPosition, 0, Math.max(0, audioBuffer.duration - 0.02));
      if (wasPlaying) play();
    } else if (!hadResult && !wasPlaying) {
      state.activeTab = 'result';
      state.playOffset = 0;
    }

    updateResultUI(result);
    updateTransport();
    updatePlayheads();
    drawWave(els.resultCanvas, state.resultPeaks, RESULT_COLORS);
  }

  /* ---------------------------------------------------------------- */
  /* rendering                                                         */
  /* ---------------------------------------------------------------- */

  async function opusEncode(channels, sampleRate, kbps) {
    const pcm = DSP.interleaveInt16(channels);
    const response = await window.crunchi.opusPass({
      pcm,
      sampleRate,
      channels: channels.length,
      kbps
    });

    return {
      bytes: new Uint8Array(response.opus),
      channels: DSP.deinterleaveInt16(response.pcm, channels.length, channels[0].length)
    };
  }

  async function startRender() {
    clearTimeout(state.renderTimer);

    if (!state.sourceBuffer) return;

    if (state.renderAbort) state.renderAbort.abort();

    const controller = new AbortController();
    const token = state.renderToken + 1;
    const source = state.sourceBuffer;
    const settings = { ...state.settings };

    state.renderToken = token;
    state.renderAbort = controller;
    state.renderKey = DSP.settingsKey(settings);
    state.busy = true;

    setBusyUI(true);
    updateProgress(0, 'WARMING UP');

    try {
      const result = await DSP.process(source, settings, {
        signal: controller.signal,
        onProgress: (value, label) => {
          if (token === state.renderToken) updateProgress(value, label);
        },
        opusEncode: state.ffmpeg ? opusEncode : null
      });

      if (token !== state.renderToken || state.sourceBuffer !== source) return;
      if (!result.channels.length || !result.channels[0].length) {
        throw new Error('The cruncher produced an empty track.');
      }

      const ctx = getCtx();
      const audioBuffer = ctx.createBuffer(
        result.channels.length,
        result.channels[0].length,
        result.sampleRate
      );

      result.channels.forEach((data, channel) => {
        audioBuffer.copyToChannel(data, channel);
      });

      applyResult(audioBuffer, result);

      state.busy = false;
      state.renderAbort = null;
      state.renderKey = null;
      setBusyUI(false);
    } catch (error) {
      if (error.name === 'AbortError') return;
      if (token !== state.renderToken) return;

      console.error(error);
      state.busy = false;
      state.renderAbort = null;
      state.renderKey = null;
      setBusyUI(false);
      refreshResultState();
      toast(error.message || 'The cruncher jammed. Try different settings.');
    }
  }

  function requestRenderSoon(delay = 320) {
    if (!state.sourceBuffer || !state.autoPreview) return;

    const wanted = DSP.settingsKey(state.settings);

    if (state.busy && state.renderKey === wanted) return;
    if (!state.busy && state.resultSettings && DSP.settingsKey(state.resultSettings) === wanted) {
      refreshResultState();
      return;
    }

    clearTimeout(state.renderTimer);
    if (state.resultBuffer && !state.busy) setResultState('UPDATING…', 'stale');

    state.renderTimer = setTimeout(() => {
      startRender();
    }, delay);
  }

  function stopRender() {
    state.renderToken += 1;
    clearTimeout(state.renderTimer);

    if (state.renderAbort) {
      state.renderAbort.abort();
      state.renderAbort = null;
    }

    state.renderKey = null;
    state.busy = false;
    setBusyUI(false);
  }

  function onSettingsChanged(immediate = false) {
    updateMeter();
    updatePresetButtons();

    if (!state.sourceBuffer) return;

    if (state.autoPreview) {
      requestRenderSoon(immediate ? 0 : 320);
    } else if (state.resultBuffer) {
      refreshResultState();
    }
  }

  /* ---------------------------------------------------------------- */
  /* loading tracks                                                    */
  /* ---------------------------------------------------------------- */

  function refreshSourceMeta() {
    if (!state.sourceBuffer) {
      els.sourceMeta.textContent = 'NO FILE LOADED';
      els.fileInfo.textContent = '—';
      return;
    }

    const buffer = state.sourceBuffer;
    els.sourceMeta.textContent =
      `${formatRate(buffer.sampleRate)} · ${buffer.numberOfChannels === 1 ? 'MONO' : 'STEREO'} · ${formatTime(buffer.duration)}`;
    els.fileInfo.textContent = formatBytes(state.sourceBytes);
  }

  function setSourceLoading(loading) {
    if (loading) {
      els.sourceMeta.textContent = 'DECODING…';
      els.crunchBtn.disabled = true;
    } else {
      refreshSourceMeta();
      els.crunchBtn.disabled = !state.sourceBuffer || state.busy;
    }
  }

  function commitSource(buffer, file) {
    stopPlayback(true);
    stopRender();

    state.sourceBuffer = buffer;
    state.sourceName = file.name || 'track';
    state.sourceBytes = Number(file.size) || 0;
    state.playOffset = 0;
    state.activeTab = 'source';
    state.lastTimeText = '';

    const peaks = computePeaks(buffer);
    state.sourcePeaks = peaks.peaks;
    state.sourcePeak = peaks.peak;

    els.sourceEmpty.hidden = true;
    els.sourceWaveWrap.classList.add('has-audio');
    els.replaceBtn.hidden = false;
    els.fileName.textContent = state.sourceName;
    refreshSourceMeta();
    resetResultUI();

    els.crunchBtn.disabled = false;
    updateTransport();
    drawWave(els.sourceCanvas, state.sourcePeaks, SOURCE_COLORS);

    if (state.autoPreview) requestRenderSoon(220);
  }

  async function loadFile(file) {
    if (!file) return;
    if (!isAudioFile(file)) {
      toast('That does not look like an audio file.');
      return;
    }

    const token = state.loadToken + 1;
    state.loadToken = token;

    stopRender();
    setSourceLoading(true);

    try {
      const bytes = await file.arrayBuffer();
      if (token !== state.loadToken) return;

      const buffer = await getCtx().decodeAudioData(bytes);
      if (token !== state.loadToken) return;

      if (!buffer || !buffer.length) {
        throw new Error('That file contains no audio.');
      }

      if (buffer.duration > MAX_SECONDS) {
        throw new Error('That track is over 30 minutes. Crunchi might run out of memory — try something shorter.');
      }

      commitSource(buffer, file);
    } catch (error) {
      if (token !== state.loadToken) return;
      console.error(error);
      setSourceLoading(false);
      toast(`Could not open that file. ${error.message || 'Try a WAV, MP3, FLAC, or M4A.'}`);
    }
  }

  async function openDialog() {
    if (state.dialogOpen) return;
    state.dialogOpen = true;
    ensureRunning();

    try {
      const opened = await window.crunchi.openAudio();
      if (!opened) return;

      const file = new File([opened.data], opened.name, { type: 'audio/*' });
      await loadFile(file);
    } catch (error) {
      console.error(error);
      toast('The file picker hit a snag.');
    } finally {
      state.dialogOpen = false;
    }
  }

  /* ---------------------------------------------------------------- */
  /* saving                                                            */
  /* ---------------------------------------------------------------- */

  async function saveBytes(data, extension) {
    if (!data || state.saving) return;

    state.saving = true;
    try {
      const result = await window.crunchi.saveFile({
        data,
        extension,
        baseName: baseName(state.sourceName)
      });

      if (result.saved) {
        const name = result.path.split(/[\\/]/).pop();
        toast(`Saved ${name}`);
      }
    } catch (error) {
      console.error(error);
      toast('Could not save that file.');
    } finally {
      state.saving = false;
    }
  }

  function saveCodec() {
    if (!state.resultBytes) return;
    saveBytes(state.resultBytes, state.resultExt);
  }

  function saveWav() {
    if (!state.resultBuffer) return;
    saveBytes(WAV.encode(state.resultBuffer), 'wav');
  }

  /* ---------------------------------------------------------------- */
  /* events + boot                                                     */
  /* ---------------------------------------------------------------- */

  function bindEvents() {
    els.openBtn.addEventListener('click', openDialog);
    els.replaceBtn.addEventListener('click', openDialog);
    els.playBtn.addEventListener('click', togglePlay);
    els.downloadCodec.addEventListener('click', saveCodec);
    els.downloadWav.addEventListener('click', saveWav);
    els.crunchBtn.addEventListener('click', () => startRender());

    abSource.addEventListener('click', () => setActive('source'));
    abResult.addEventListener('click', () => setActive('result'));

    els.sourceWaveWrap.addEventListener('click', (event) => {
      if (!state.sourceBuffer) {
        openDialog();
        return;
      }
      seekTo('source', ratioFromEvent(event, els.sourceWaveWrap));
    });

    els.resultWaveWrap.addEventListener('click', (event) => {
      if (!state.resultBuffer) return;
      seekTo('result', ratioFromEvent(event, els.resultWaveWrap));
    });

    Object.keys(CONTROL_UI).forEach((key) => {
      const input = CONTROL_UI[key].el;

      input.addEventListener('input', () => {
        state.settings[key] = Number(input.value);
        updateControlUI(key);
        updateMeter();
        updatePresetButtons();
        if (state.autoPreview) requestRenderSoon(520);
      });

      input.addEventListener('change', () => {
        state.settings[key] = Number(input.value);
        if (state.autoPreview) requestRenderSoon(120);
        else if (state.resultBuffer) refreshResultState();
      });
    });

    els.presets.addEventListener('click', (event) => {
      const button = event.target.closest('button[data-preset]');
      if (!button) return;
      const preset = PRESETS[button.dataset.preset];
      if (!preset) return;

      Object.assign(state.settings, preset.settings);
      syncSettingsUI();
      updateMeter();
      updatePresetButtons();

      if (state.autoPreview) requestRenderSoon(0);
      else if (state.resultBuffer) refreshResultState();
    });

    els.mono.addEventListener('change', () => {
      state.settings.mono = els.mono.checked;
      onSettingsChanged();
    });

    els.passes.addEventListener('change', () => {
      state.settings.passes = Number(els.passes.value);
      onSettingsChanged();
    });

    els.engine.addEventListener('change', () => {
      if (els.engine.value === 'opus' && !state.ffmpeg) {
        els.engine.value = 'mp3';
        state.settings.engine = 'mp3';
        toast('Opus needs ffmpeg. Install it, then restart Crunchi.');
        return;
      }
      state.settings.engine = els.engine.value;
      onSettingsChanged(true);
    });

    els.autoPreview.addEventListener('change', () => {
      state.autoPreview = els.autoPreview.checked;
      if (state.autoPreview && state.sourceBuffer) requestRenderSoon(0);
      else if (state.resultBuffer) refreshResultState();
    });

    window.addEventListener('keydown', (event) => {
      const tag = (document.activeElement && document.activeElement.tagName) || '';
      const typing = ['INPUT', 'SELECT', 'TEXTAREA', 'BUTTON'].includes(tag);

      if (event.code === 'Space' && !typing) {
        event.preventDefault();
        togglePlay();
      }

      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
        event.preventDefault();
        if (state.resultBytes) saveCodec();
      }
    });

    window.addEventListener('dragenter', (event) => {
      event.preventDefault();
      state.dragDepth += 1;
      document.body.classList.add('dragging');
    });

    window.addEventListener('dragover', (event) => {
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
    });

    window.addEventListener('dragleave', (event) => {
      event.preventDefault();
      state.dragDepth = Math.max(0, state.dragDepth - 1);
      if (state.dragDepth === 0) document.body.classList.remove('dragging');
    });

    window.addEventListener('drop', (event) => {
      event.preventDefault();
      state.dragDepth = 0;
      document.body.classList.remove('dragging');
      const file = event.dataTransfer && event.dataTransfer.files ? event.dataTransfer.files[0] : null;
      if (file) loadFile(file);
    });

    let redrawFrame = 0;
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(redrawFrame);
      redrawFrame = requestAnimationFrame(redrawAll);
    });
    observer.observe(els.sourceCanvas);
    observer.observe(els.resultCanvas);

    window.crunchi.onMenuOpen(() => openDialog());
  }

  function applyAppInfo(info) {
    if (!info) return;

    state.ffmpeg = Boolean(info.ffmpeg);
    if (info.version) els.versionLabel.textContent = `v${info.version}`;

    if (state.ffmpeg) {
      els.ffmpegStatus.textContent = 'OPUS: READY';
      els.ffmpegStatus.className = 'ffmpeg-status ready';
      els.ffmpegStatus.title = info.ffmpegPath || 'ffmpeg found';
      if (opusOption) opusOption.disabled = false;
    } else {
      els.ffmpegStatus.textContent = 'OPUS: NEEDS FFMPEG';
      els.ffmpegStatus.className = 'ffmpeg-status missing';
      els.ffmpegStatus.title = 'Install ffmpeg to unlock Opus, then restart Crunchi.';
      if (opusOption) opusOption.disabled = true;
      if (state.settings.engine === 'opus') {
        state.settings.engine = 'mp3';
        syncSettingsUI();
      }
    }
  }

  async function init() {
    buildMeter();
    syncSettingsUI();
    updateMeter();
    updatePresetButtons();
    bindEvents();
    updateTransport();
    redrawAll();

    try {
      applyAppInfo(await window.crunchi.appInfo());
    } catch (error) {
      els.ffmpegStatus.textContent = 'OPUS: UNAVAILABLE';
      els.ffmpegStatus.className = 'ffmpeg-status missing';
      if (opusOption) opusOption.disabled = true;
    }
  }

  init();
})();
