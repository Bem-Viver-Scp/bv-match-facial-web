// src/pwa.ts
import { registerSW } from 'virtual:pwa-register';

export function setupPWA(toast?: (msg: string, onReload: () => void) => void) {
  const updateSW = registerSW({
    onNeedRefresh() {
      if (toast) toast('Nova versão disponível', () => updateSW(true));
      else if (confirm('Nova versão disponível. Atualizar agora?'))
        updateSW(true);
    },
    onOfflineReady() {
      console.log('PWA offline pronto');
    },
  });
}
