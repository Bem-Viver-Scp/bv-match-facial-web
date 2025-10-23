// electron/main.cjs
const { app, BrowserWindow, session } = require('electron');
const path = require('path');
const fs = require('fs');

const ELECTRON_DEV = process.env.ELECTRON_DEV === 'true';
const IS_RASPBERRY = process.env.IS_RASPBERRY === 'true';
function resolveIndexHtml() {
  // Em dev servimos via Vite
  if (ELECTRON_DEV) return null;

  // Em produção use o caminho real do app (dentro do asar)
  // app.getAppPath() -> .../resources/app
  const appRoot = app.getAppPath();
  const candidate = path.join(appRoot, 'dist', 'index.html');

  // Fallback caso sua estrutura esteja diferente
  const alt1 = path.join(__dirname, '..', 'dist', 'index.html');
  const alt2 = path.join(
    process.resourcesPath || '',
    'app',
    'dist',
    'index.html'
  );

  for (const p of [candidate, alt1, alt2]) {
    try {
      if (p && fs.existsSync(p)) return p;
    } catch {}
  }
  return candidate; // ainda retorna algo para logar erro
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    fullscreen: true, // tela cheia
    backgroundColor: '#000000', // evita flash branco
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'preload.cjs'),
      // Desative sandbox em algumas distros Linux que bloqueiam file://
      sandbox: false,
    },
  });

  // Logs úteis para diagnosticar "tela branca"
  win.webContents.on('did-fail-load', (_e, code, desc, url) => {
    console.error('❌ did-fail-load', code, desc, url);
  });
  win.webContents.on('dom-ready', () => console.log('✅ dom-ready'));
  win.webContents.on('did-finish-load', () =>
    console.log('✅ did-finish-load')
  );

  if (ELECTRON_DEV) {
    win.loadURL('http://localhost:5173/');
    win.webContents.openDevTools({ mode: 'detach' });
  } else {
    const indexPath = resolveIndexHtml();
    console.log('📦 Carregando build:', indexPath);
    win
      .loadFile(indexPath)
      .catch((err) => console.error('❌ Erro ao carregar index.html:', err));
  }

  return win;
}

if (IS_RASPBERRY) {
  console.log('🐧 Rodando no Raspberry — desativando aceleração de hardware');
  app.disableHardwareAcceleration();
}
app.whenReady().then(() => {
  // ⚠️ Em algumas distros Linux é preciso isso para getUserMedia com file://
  app.commandLine.appendSwitch('no-sandbox');
  app.commandLine.appendSwitch('js-flags', '--experimental-wasm-simd');
  app.commandLine.appendSwitch('no-sandbox');

  // ✅ Autoriza câmera/microfone automaticamente
  const ses = session.defaultSession;

  ses.setPermissionRequestHandler(
    (webContents, permission, callback, details) => {
      if (permission === 'media') {
        try {
          const url = new URL(details.requestingUrl || 'file://');
          const trusted =
            url.protocol === 'file:' ||
            url.origin === 'http://localhost:5173' ||
            url.origin === 'https://localhost:5173';
          callback(trusted);
          return;
        } catch {
          callback(true); // em file:// sem URL, permita
          return;
        }
      }
      callback(false);
    }
  );

  ses.setPermissionCheckHandler((_wc, permission) => {
    if (permission === 'media') return true;
    return false;
  });

  // Abrir na inicialização do sistema (auto-launch) — comente se não quiser
  if (app.isPackaged) {
    app.setLoginItemSettings({ openAtLogin: true, openAsHidden: false });
  }

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
