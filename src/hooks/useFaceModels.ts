import { useEffect, useState } from 'react';
import * as faceapi from 'face-api.js';

export function useFaceModels(basePath = '/models') {
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancel = false;
    (async () => {
      try {
        await faceapi.nets.ssdMobilenetv1.loadFromUri(basePath);
        await faceapi.nets.faceLandmark68Net.loadFromUri(basePath);
        await faceapi.nets.faceRecognitionNet.loadFromUri(basePath);
        if (!cancel) setLoaded(true);
      } catch (e: any) {
        if (!cancel) setError(e?.message || 'Falha ao carregar modelos');
      }
    })();
    return () => {
      cancel = true;
    };
  }, [basePath]);

  return { loaded, error };
}
