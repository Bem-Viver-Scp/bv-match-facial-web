// electron/preload.cjs
const { contextBridge } = require('electron');
contextBridge.exposeInMainWorld('electronAPI', {});
