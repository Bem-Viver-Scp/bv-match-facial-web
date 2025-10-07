const { app, BrowserWindow, session } = require('electron');
const path = require('path');

const ELECTRON_DEV = process.env.ELECTRON_DEV === 'true';

function createWindow() {
  const win = new BrowserWindow({
    width: 1024,
    height: 768,
    fullscreen: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'preload.cjs'),
    },
  });

  if (ELECTRON_DEV) {
    win.loadURL('http://localhost:5173/');
    win.webContents.openDevTools({ mode: 'detach' });
  } else {
    win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
  }
}

app.whenReady().then(async () => {
  // 🔓 Autoriza automaticamente 'media' (câmera/mic)
  const ses = session.defaultSession;

  // Para pedidos de permissão (ex.: getUserMedia)
  ses.setPermissionRequestHandler(
    (webContents, permission, callback, details) => {
      // permission pode ser: 'media', 'geolocation', 'notifications', etc.
      if (permission === 'media') {
        // Opcional: libere só do seu app (file:) e do localhost (dev)
        const url = new URL(details.requestingUrl || 'file://');
        const isTrusted =
          url.protocol === 'file:' ||
          url.origin === 'http://localhost:5173' ||
          url.origin === 'https://localhost:5173'; // dependendo do setup

        callback(isTrusted);
        return;
      }

      // Bloqueia o resto por padrão
      callback(false);
    }
  );

  // Opcional: diz pro Chromium que já “temos” permissão
  // (melhora casos em que a checagem acontece antes do request)
  ses.setPermissionCheckHandler((_wc, permission, _origin, _details) => {
    if (permission === 'media') return true;
    return false;
  });

  // macOS: garanta que o Info.plist tem NSCameraUsageDescription (você já setou via electron-builder)
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  // No macOS costuma ficar aberto; ajuste se preferir fechar
  if (process.platform !== 'darwin') app.quit();
});
