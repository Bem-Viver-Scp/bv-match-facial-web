// src/pwa.ts
import { registerSW } from 'virtual:pwa-register';

export function setupPWA(toast?: (msg: string, onReload: () => void) => void) {
  const updateSW = registerSW({
    onNeedRefresh() {
      // chamado quando há uma nova versão do SW esperando
      if (toast) {
        toast('Nova versão disponível', () => updateSW(true));
      } else {
        if (confirm('Nova versão disponível. Atualizar agora?')) updateSW(true);
      }
    },
    onOfflineReady() {
      // app pronto para usar offline
      console.log('PWA pronto para uso offline');
    },
  });
}
