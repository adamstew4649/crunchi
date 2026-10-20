const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('crunchi', {
  appInfo: () => ipcRenderer.invoke('app:info'),
  openAudio: () => ipcRenderer.invoke('dialog:open-audio'),
  saveFile: (payload) => ipcRenderer.invoke('dialog:save-file', payload),
  opusPass: (payload) => ipcRenderer.invoke('codec:opus', payload),
  onMenuOpen: (callback) => {
    const handler = () => callback();
    ipcRenderer.on('menu:open', handler);
    return () => ipcRenderer.removeListener('menu:open', handler);
  }
});
