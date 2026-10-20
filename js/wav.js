/* Crunchi — tiny 16-bit WAV writer */
(() => {
  'use strict';

  function writeString(view, offset, text) {
    for (let i = 0; i < text.length; i += 1) {
      view.setUint8(offset + i, text.charCodeAt(i));
    }
  }

  /**
   * Encode an AudioBuffer as a 16-bit PCM WAV file.
   * @param {AudioBuffer} audioBuffer
   * @returns {Uint8Array}
   */
  function encode(audioBuffer) {
    const channels = audioBuffer.numberOfChannels;
    const frames = audioBuffer.length;
    const sampleRate = audioBuffer.sampleRate;
    const bytesPerSample = 2;
    const dataSize = frames * channels * bytesPerSample;
    const buffer = new ArrayBuffer(44 + dataSize);
    const view = new DataView(buffer);

    writeString(view, 0, 'RIFF');
    view.setUint32(4, 36 + dataSize, true);
    writeString(view, 8, 'WAVE');
    writeString(view, 12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, channels, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * channels * bytesPerSample, true);
    view.setUint16(32, channels * bytesPerSample, true);
    view.setUint16(34, 16, true);
    writeString(view, 36, 'data');
    view.setUint32(40, dataSize, true);

    const data = [];
    for (let channel = 0; channel < channels; channel += 1) {
      data.push(audioBuffer.getChannelData(channel));
    }

    let offset = 44;
    for (let frame = 0; frame < frames; frame += 1) {
      for (let channel = 0; channel < channels; channel += 1) {
        let sample = data[channel][frame];
        if (sample > 1) sample = 1;
        else if (sample < -1) sample = -1;
        view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
        offset += 2;
      }
    }

    return new Uint8Array(buffer);
  }

  window.CrunchiWav = { encode };
})();
