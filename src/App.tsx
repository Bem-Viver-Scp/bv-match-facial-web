import { useState } from 'react';
import CameraAutoCapture from './components/CameraCapture';

type Screen = 'home' | 'camera';

export default function KioskRoot() {
  const [screen, setScreen] = useState<Screen>('home');

if (screen === 'home') {
  return (
    <div className="w-screen h-screen flex flex-col items-center justify-center bg-black text-white">
      <div className="flex flex-col items-center gap-4 px-4 w-full max-w-xs">
        <h1 className="text-[18px] font-semibold text-center tracking-wide">
          Bem-vindo
        </h1>

        <button
          onClick={() => setScreen('camera')}
          className="
            w-full
            py-3
            rounded-2xl
            bg-emerald-500
            active:bg-emerald-600
            text-base
            font-semibold
            shadow-lg
            text-black
          "
        >
          Iniciar reconhecimento
        </button>
      </div>
    </div>
  );
}

  // Tela da webcam
  return (
    <CameraAutoCapture
      // se ficar muito tempo na tela da câmera → volta pra home
      onTimeout={() => setScreen('home')}
      // depois de um reconhecimento (match ou sem match) → volta pra home
      onFinished={() => setScreen('home')}
      // tempo máximo na tela da câmera (ms) – pode ajustar
      maxIdleMs={60_000}
    />
  );
}