const { app, BrowserWindow, Menu, dialog, ipcMain } = require('electron');
const path = require('node:path');
const fs = require('node:fs/promises');
const os = require('node:os');
const { execFile } = require('node:child_process');

const AUDIO_EXTENSIONS = [
  'wav', 'mp3', 'flac', 'm4a', 'aac', 'ogg', 'oga', 'opus',
  '3gp', '3g2', 'aif', 'aiff', 'caf', 'webm', 'mp4'
];

let mainWindow = null;
let ffmpegCache;
let ffmpegCheckedAt = 0;

app.setName('Crunchi');

/* ------------------------------------------------------------------ */
/* ffmpeg discovery                                                    */
/* ------------------------------------------------------------------ */

async function probe(binary) {
  return new Promise((resolve) => {
    execFile(binary, ['-version'], { timeout: 5000 }, (err) => resolve(!err));
  });
}

async function findFfmpeg(force = false) {
  const now = Date.now();
  if (!force && ffmpegCache !== undefined && now - ffmpegCheckedAt < 30000) {
    return ffmpegCache;
  }

  const candidates = [
    process.env.FFMPEG_PATH,
    '/opt/homebrew/bin/ffmpeg',
    '/usr/local/bin/ffmpeg',
    '/usr/bin/ffmpeg',
    'ffmpeg'
  ].filter(Boolean);

  let found = null;
  for (const candidate of candidates) {
    if (await probe(candidate)) {
      found = candidate;
      break;
    }
  }

  ffmpegCache = found;
  ffmpegCheckedAt = now;
  return found;
}

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

function execFileBuffer(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      { maxBuffer: 1024 * 1024 * 1024, encoding: 'buffer', ...options },
      (error, stdout, stderr) => {
        if (error) {
          error.stderrText = stderr ? stderr.toString().trim() : '';
          reject(error);
          return;
        }
        resolve({ stdout, stderr });
      }
    );
  });
}

function wavFromPcm16(pcm, sampleRate, channels) {
  const dataSize = pcm.byteLength;
  const buffer = Buffer.alloc(44 + dataSize);

  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write('WAVE', 8);
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(channels, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * channels * 2, 28);
  buffer.writeUInt16LE(channels * 2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36);
  buffer.writeUInt32LE(dataSize, 40);

  Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength).copy(buffer, 44);
  return buffer;
}

function cleanName(name) {
  return String(name || 'track')
    .replace(/\.[^.]+$/, '')
    .replace(/[\\/:*?"<>|]/g, '')
    .trim()
    .slice(0, 120) || 'track';
}

/* ------------------------------------------------------------------ */
/* window                                                              */
/* ------------------------------------------------------------------ */

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 880,
    minWidth: 980,
    minHeight: 740,
    backgroundColor: '#0e0c0a',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 20, y: 24 },
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  mainWindow.loadFile('index.html');

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    mainWindow.focus();
  });

  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', (event) => event.preventDefault());

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function buildMenu() {
  const isMac = process.platform === 'darwin';
  const template = [];

  if (isMac) {
    template.push({
      label: 'Crunchi',
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' }
      ]
    });
  }

  template.push({
    label: 'File',
    submenu: [
      {
        label: 'Open Audio…',
        accelerator: 'CmdOrCtrl+O',
        click: () => mainWindow && mainWindow.webContents.send('menu:open')
      },
      { type: 'separator' },
      isMac ? { role: 'close' } : { role: 'quit' }
    ]
  });

  template.push({ role: 'editMenu' });
  template.push({ role: 'windowMenu' });

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

/* ------------------------------------------------------------------ */
/* IPC                                                                 */
/* ------------------------------------------------------------------ */

ipcMain.handle('app:info', async () => {
  const ffmpeg = await findFfmpeg();
  return {
    version: app.getVersion(),
    platform: process.platform,
    ffmpeg: Boolean(ffmpeg),
    ffmpegPath: ffmpeg || null
  };
});

ipcMain.handle('dialog:open-audio', async () => {
  if (!mainWindow) return null;

  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Open a track',
    properties: ['openFile'],
    filters: [
      { name: 'Audio', extensions: AUDIO_EXTENSIONS },
      { name: 'All Files', extensions: ['*'] }
    ]
  });

  if (result.canceled || !result.filePaths.length) return null;

  const filePath = result.filePaths[0];
  const [data, stat] = await Promise.all([
    fs.readFile(filePath),
    fs.stat(filePath)
  ]);

  return {
    name: path.basename(filePath),
    path: filePath,
    size: stat.size,
    data
  };
});

ipcMain.handle('dialog:save-file', async (_event, payload) => {
  if (!mainWindow) return { saved: false };
  if (!payload || !payload.data) throw new Error('Nothing to save.');

  const bytes = Buffer.from(payload.data);
  const extension = String(payload.extension || 'wav').toLowerCase();
  const filters = {
    wav: [{ name: 'WAV audio', extensions: ['wav'] }],
    mp3: [{ name: 'MP3 audio', extensions: ['mp3'] }],
    opus: [{ name: 'Opus audio', extensions: ['opus'] }],
    '3gp': [{ name: '3GP audio', extensions: ['3gp'] }]
  }[extension] || [{ name: 'Audio', extensions: [extension] }];

  const result = await dialog.showSaveDialog(mainWindow, {
    title: 'Save crunchy track',
    defaultPath: `${cleanName(payload.baseName)} (crunchy).${extension}`,
    filters
  });

  if (result.canceled || !result.filePath) return { saved: false };

  await fs.writeFile(result.filePath, bytes);
  return { saved: true, path: result.filePath };
});

async function encodeWithFfmpeg(payload, codec) {
  const ffmpeg = await findFfmpeg();
  if (!ffmpeg) throw new Error('ffmpeg was not found on this machine.');

  if (!payload || !payload.pcm) throw new Error('No audio data was supplied.');

  const sampleRate = Math.round(Number(payload.sampleRate) || 44100);
  const channels = Number(payload.channels) === 1 ? 1 : 2;
  const pcm = payload.pcm;

  if (pcm.length % channels !== 0) {
    throw new Error('The audio data is not aligned to the channel count.');
  }

  const isThreeGp = codec === '3gp';
  const extension = isThreeGp ? '3gp' : 'opus';
  const kbps = isThreeGp
    ? Math.max(8, Math.min(32, Math.round(Number(payload.kbps) || 24)))
    : Math.max(6, Math.min(128, Math.round(Number(payload.kbps) || 12)));

  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'crunchi-'));
  const inputPath = path.join(tempDir, 'input.wav');
  const outputPath = path.join(tempDir, `output.${extension}`);

  try {
    await fs.writeFile(inputPath, wavFromPcm16(pcm, sampleRate, channels));

    const encodeArgs = isThreeGp
      ? [
          '-hide_banner', '-loglevel', 'error', '-y',
          '-i', inputPath,
          '-vn', '-map_metadata', '-1',
          '-c:a', 'aac',
          '-b:a', `${kbps}k`,
          '-ar', '8000',
          '-ac', '1',
          '-f', '3gp',
          outputPath
        ]
      : [
          '-hide_banner', '-loglevel', 'error', '-y',
          '-i', inputPath,
          '-vn', '-map_metadata', '-1',
          '-c:a', 'libopus',
          '-b:a', `${kbps}k`,
          '-vbr', 'off',
          '-frame_duration', '60',
          '-ac', String(channels),
          '-f', 'opus',
          outputPath
        ];

    await execFileBuffer(ffmpeg, encodeArgs);

    const encoded = await fs.readFile(outputPath);

    const { stdout } = await execFileBuffer(ffmpeg, [
      '-hide_banner', '-loglevel', 'error',
      '-i', outputPath,
      '-f', 's16le',
      '-acodec', 'pcm_s16le',
      '-ar', String(sampleRate),
      '-ac', String(channels),
      'pipe:1'
    ]);

    const usable = stdout.length - (stdout.length % 2);
    const pcmOut = new Int16Array(usable / 2);
    for (let i = 0; i < pcmOut.length; i += 1) {
      pcmOut[i] = stdout.readInt16LE(i * 2);
    }

    return {
      bytes: new Uint8Array(encoded),
      pcm: pcmOut,
      sampleRate,
      channels,
      kbps,
      codec: isThreeGp ? '3gp' : 'opus'
    };
  } catch (error) {
    const detail = error.stderrText ? ` ${error.stderrText.split('\n').slice(-2).join(' ')}` : '';
    throw new Error(`ffmpeg could not crunch this track.${detail}`.trim());
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}

ipcMain.handle('codec:opus', (_event, payload) => encodeWithFfmpeg(payload, 'opus'));
ipcMain.handle('codec:3gp', (_event, payload) => encodeWithFfmpeg(payload, '3gp'));

/* ------------------------------------------------------------------ */
/* lifecycle                                                           */
/* ------------------------------------------------------------------ */

app.whenReady().then(async () => {
  buildMenu();
  createWindow();
  findFfmpeg();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
