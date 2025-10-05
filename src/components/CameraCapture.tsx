/* eslint-disable no-empty */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { useEffect, useMemo, useRef, useState } from 'react';
import * as faceapi from '@vladmandic/face-api';
import { postMatch } from '../api';
import Lottie from 'lottie-react';
import loadingAnim from '../assets/recognize_loading.json';

const baseUrl = '/models';

const GUIDE = {
  centerX: 0.5,
  centerY: 0.48,
  targetRadius: 0.32,
  posTol: 0.28,
  sizeTol: 0.35,
  angleTolDeg: 18,
};

const RUN = {
  intervalMs: 100,
  lockConsecutive: 3,
  minScore: 0.5,
  captureOnYellowAfter: 8,
};

type FitFeedback = 'bad' | 'ok' | 'good';

type MatchResp = {
  match: null | {
    id: string;
    name: string;
    email?: string;
    avatar_url?: string | null;
    distance: number;
  };
  threshold: number;
  gap?: number;
  zscore?: number;
  bestDistance?: number;
};

export default function CameraAutoCapture() {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const overlayRef = useRef<HTMLCanvasElement | null>(null);
  const drawRef = useRef<HTMLCanvasElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [modelsReady, setModelsReady] = useState(false);
  const [cameraReady, setCameraReady] = useState(false);
  const [overlayReady, setOverlayReady] = useState(false);

  const [status, setStatus] = useState('iniciando…');
  const [preview, setPreview] = useState<string | null>(null);
  const [locked, setLocked] = useState(false);
  const [loading, setLoading] = useState(false);

  const [resp, setResp] = useState<MatchResp | null>(null);

  const consecOk = useRef(0);
  const loopId = useRef<number | null>(null);

  const appReady = useMemo(
    () => modelsReady && cameraReady && overlayReady,
    [modelsReady, cameraReady, overlayReady]
  );

  // Carrega modelos
  useEffect(() => {
    let cancel = false;
    (async () => {
      try {
        await faceapi.nets.tinyFaceDetector.loadFromUri(baseUrl);
        await faceapi.nets.faceLandmark68Net.loadFromUri(baseUrl);
        await faceapi.nets.faceRecognitionNet.loadFromUri(baseUrl);
        if (!cancel) {
          setModelsReady(true);
          setStatus('modelos prontos');
        }
      } catch (e: any) {
        setStatus('erro modelos: ' + (e?.message ?? e));
      }
    })();
    return () => {
      cancel = true;
    };
  }, []);

  useEffect(() => {
    if (!modelsReady) return;
    let pollId: number | null = null;

    const waitForVideoDims = async (video: HTMLVideoElement) => {
      let tries = 0;
      await new Promise<void>((resolve) => {
        const check = () => {
          tries++;
          if (video.videoWidth > 0 && video.videoHeight > 0) resolve();
          else if (tries > 60) resolve();
          else pollId = window.setTimeout(check, 50);
        };
        check();
      });
    };

    (async () => {
      try {
        setStatus('abrindo câmera…');

        // se já temos stream, reusa:
        if (!streamRef.current) {
          streamRef.current = await navigator.mediaDevices.getUserMedia({
            video: {
              facingMode: 'user',
              width: { ideal: 1280 },
              height: { ideal: 720 },
            },
            audio: false,
          });
        }

        const video = videoRef.current!;
        video.muted = true;
        (video as any).playsInline = true;
        video.srcObject = streamRef.current;
        await video.play();
        await waitForVideoDims(video);

        setCameraReady(true);
        syncSizes();
        setOverlayReady(true);
        setStatus('câmera pronta');
      } catch (e: any) {
        setStatus('erro câmera: ' + (e?.message ?? e));
      }
    })();

    return () => {
      if (pollId) window.clearTimeout(pollId);
      // ⚠️ não paramos o stream aqui, pois trocar de tela (preview) desmonta o <video>, não o componente inteiro
      // streams serão parados apenas quando o componente desmontar de verdade (veja efeito abaixo).
    };
  }, [modelsReady]);

  // pare os tracks apenas quando o componente desmontar de verdade:
  useEffect(() => {
    return () => {
      if (streamRef.current) {
        streamRef.current.getTracks().forEach((t) => t.stop());
        streamRef.current = null;
      }
    };
  }, []);
  useEffect(() => {
    if (!locked && modelsReady) {
      // saiu do preview: reanexa o stream ao <video>
      ensureCamera();
    }
  }, [locked, modelsReady]);
  useEffect(() => {
    if (locked && preview && resp && !loading) {
      const t = setTimeout(() => {
        (async () => {
          await handleReset();
        })();
      }, 5000);
      return () => clearTimeout(t);
    }
  }, [locked, preview, resp, loading]);
  // Overlay segue o vídeo
  useEffect(() => {
    if (!containerRef.current) return;
    const ro = new ResizeObserver(() => {
      syncSizes();
      if (cameraReady) setOverlayReady(true);
    });
    ro.observe(containerRef.current);
    return () => ro.disconnect();
  }, [cameraReady]);

  function syncSizes() {
    const video = videoRef.current;
    const overlay = overlayRef.current;
    const draw = drawRef.current;
    if (!video || !overlay || !draw) return;
    const rect = video.getBoundingClientRect();

    overlay.style.width = `${rect.width}px`;
    overlay.style.height = `${rect.height}px`;

    const dpr = Math.max(1, window.devicePixelRatio || 1);
    overlay.width = Math.round(rect.width * dpr);
    overlay.height = Math.round(rect.height * dpr);
    const octx = overlay.getContext('2d')!;
    octx.setTransform(dpr, 0, 0, dpr, 0, 0);
    octx.clearRect(0, 0, rect.width, rect.height);

    draw.width = video.videoWidth || Math.round(rect.width * dpr);
    draw.height = video.videoHeight || Math.round(rect.height * dpr);
  }

  // Loop de detecção
  useEffect(() => {
    if (!appReady) return;

    const run = async () => {
      const video = videoRef.current;
      const overlay = overlayRef.current;
      const draw = drawRef.current;
      if (!video || !overlay || !draw || locked || video.readyState < 2) return;

      const rect = video.getBoundingClientRect();
      const dpr = Math.max(1, window.devicePixelRatio || 1);
      if (
        overlay.width !== Math.round(rect.width * dpr) ||
        overlay.height !== Math.round(rect.height * dpr)
      ) {
        syncSizes();
      }

      const dctx = draw.getContext('2d')!;
      const octx = overlay.getContext('2d')!;
      const vw = video.videoWidth || rect.width;
      const vh = video.videoHeight || rect.height;

      dctx.setTransform(1, 0, 0, 1, 0, 0);
      dctx.drawImage(video, 0, 0, vw, vh);

      octx.clearRect(0, 0, rect.width, rect.height);
      const guide = drawGuide(octx, rect.width, rect.height);

      const opts = new faceapi.TinyFaceDetectorOptions({
        inputSize: 416,
        scoreThreshold: 0.5,
      });
      const det = await faceapi
        .detectSingleFace(draw, opts)
        .withFaceLandmarks()
        .withFaceDescriptor();

      if (!det || (det.detection.score ?? 0) < RUN.minScore) {
        consecOk.current = 0;
        drawStatus(octx, guide, 'bad');
        setStatus('posicione o rosto dentro da moldura');
        return;
      }

      const fit = fitFaceToGuide(det, vw, vh, guide);
      drawStatus(octx, guide, fit.mood, fit.score);

      if (fit.mood === 'good') consecOk.current++;
      else if (fit.mood === 'ok' && RUN.captureOnYellowAfter)
        consecOk.current++;
      else consecOk.current = 0;

      const need =
        fit.mood === 'good'
          ? RUN.lockConsecutive
          : RUN.captureOnYellowAfter || 9999;
      if (consecOk.current >= need) {
        consecOk.current = 0;
        setLocked(true);
        setLoading(true);
        setStatus('capturando…');

        const descriptor = Array.from(det.descriptor);
        const photo = draw.toDataURL('image/jpeg', 0.9);
        setPreview(photo);

        try {
          const r: MatchResp = await postMatch(descriptor);
          setResp(r);
          if (r.match) setStatus('reconhecido');
          else setStatus('sem match');
        } catch (e: any) {
          setStatus('erro no match: ' + (e?.message ?? e));
        } finally {
          setLoading(false);
        }
        return;
      }

      setStatus(`ajuste o rosto — ${consecOk.current}/${need}`);
    };

    loopId.current = window.setInterval(run, RUN.intervalMs);
    return () => {
      if (loopId.current) window.clearInterval(loopId.current);
    };
  }, [appReady, locked]);
  async function ensureCamera() {
    const video = videoRef.current;
    if (!video) return;

    // se já temos um stream ativo, apenas reanexa
    if (streamRef.current) {
      video.srcObject = streamRef.current;
    } else {
      streamRef.current = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: 'user',
          width: { ideal: 1280 },
          height: { ideal: 720 },
        },
        audio: false,
      });
      video.srcObject = streamRef.current;
    }

    video.muted = true;
    (video as any).playsInline = true;
    try {
      await video.play();
    } catch {}
    // se ainda não temos dimensões, força um pequeno delay
    if (video.videoWidth === 0 || video.videoHeight === 0) {
      await new Promise((r) => setTimeout(r, 50));
    }
    syncSizes();
    setCameraReady(true);
    setOverlayReady(true);
  }

  async function handleReset() {
    setLocked(false);
    setPreview(null);
    setResp(null);
    setLoading(false);
    consecOk.current = 0;
    setStatus('câmera pronta');

    await ensureCamera(); // <- garante vídeo reanexado e tocando
  }

  // ===== RENDER =====

  // Tela de carregamento centrada
  // if (!appReady) {
  //   return (
  //     <div className="min-h-screen grid place-items-center">
  //       <div className="flex flex-col items-center gap-2 text-gray-700">
  //         <Lottie
  //           animationData={loadingAnim}
  //           loop
  //           autoplay
  //           style={{ width: 120, height: 120 }}
  //         />
  //         <div>
  //           {!modelsReady
  //             ? 'Carregando modelos…'
  //             : !cameraReady
  //             ? 'Abrindo câmera…'
  //             : !overlayReady
  //             ? 'Ajustando overlay…'
  //             : 'Preparando…'}
  //         </div>
  //         <code className="text-xs text-gray-500 mt-1">
  //           flags → models:{String(modelsReady)} | cam:{String(cameraReady)} |
  //           overlay:{String(overlayReady)}
  //         </code>
  //       </div>
  //     </div>
  //   );
  // }

  // Tela de captura: centralizada e com loading circular

  if (locked && preview) {
    const ringSize = 520; // diâmetro do anel Lottie
    const imgSize = 240; // diâmetro da sua foto
    const inset = (ringSize - imgSize) / 2;

    const m = resp?.match;
    const showMatch = Boolean(m);
    const dist = m?.distance ?? resp?.bestDistance;

    return (
      <div className="min-h-screen grid place-items-center px-4">
        <div className="flex flex-col items-center gap-8 w-full max-w-4xl">
          {/* Linha com "Você" e "Match" */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-10 sm:gap-16 place-items-center w-full">
            {/* SUA CAPTURA: LOTTIE ATRÁS + IMAGEM NA FRENTE */}
            <div
              className="relative"
              style={{ width: ringSize, height: ringSize }}
            >
              {/* Lottie fica por baixo da imagem */}
              {/* {loading && ( */}
              <Lottie
                animationData={loadingAnim}
                loop
                autoplay
                style={{
                  position: 'absolute',
                  left: 0,

                  inset: 0,
                  width: ringSize,
                  height: ringSize,
                  pointerEvents: 'none',
                  zIndex: 1, // atrás
                }}
                rendererSettings={{ preserveAspectRatio: 'xMidYMid slice' }}
              />
              {/* )} */}

              {/* Foto por cima */}
              <img
                src={preview}
                alt="Você"
                style={{
                  position: 'absolute',
                  top: inset,
                  left: inset,
                  width: imgSize,
                  height: imgSize,
                  objectFit: 'cover',
                  borderRadius: '9999px',
                  boxShadow:
                    '0 10px 20px rgba(0,0,0,0.15), inset 0 0 0 2px rgba(255,255,255,0.9)',
                  zIndex: 1, // na frente
                }}
              />

              <div className="absolute -bottom-7 w-full text-center text-sm text-gray-700">
                Você
              </div>
            </div>

            {/* Foto do médico reconhecido (ou placeholder) */}
            <div className="flex flex-col items-center">
              <div
                className="rounded-full overflow-hidden border shadow"
                style={{ width: 240, height: 240 }}
              >
                {showMatch && m?.avatar_url ? (
                  <img
                    src={m.avatar_url}
                    alt={m.name}
                    style={{
                      width: '100%',
                      height: '100%',
                      objectFit: 'cover',
                    }}
                  />
                ) : (
                  <div className="grid place-items-center w-full h-full bg-gray-100 text-gray-500 text-4xl font-semibold">
                    {showMatch ? (m?.name?.[0] ?? '?').toUpperCase() : '?'}
                  </div>
                )}
              </div>
              <div className="text-sm text-gray-700 mt-2">
                {showMatch ? m?.name ?? 'Match' : 'Sem match'}
              </div>
            </div>
          </div>

          {/* Cartão de resultado */}
          <div className="w-full max-w-2xl rounded-2xl border shadow-sm p-5 bg-white">
            <div className="flex items-start gap-4">
              <div className="flex-1">
                <div className="text-sm text-gray-600 mb-1">
                  {resp?.match ? 'Reconhecido' : 'Sem match'}
                </div>
                {showMatch ? (
                  <div className="text-xl font-semibold">{m?.name}</div>
                ) : (
                  <div className="text-xl font-semibold">Não reconhecido</div>
                )}

                <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-gray-700">
                  {typeof dist === 'number' && (
                    <span className="px-2 py-1 rounded-full bg-gray-100 border">
                      dist: {dist.toFixed(3)}
                    </span>
                  )}
                  {typeof resp?.gap === 'number' && (
                    <span className="px-2 py-1 rounded-full bg-gray-100 border">
                      gap: {resp.gap.toFixed(3)}
                    </span>
                  )}
                  {typeof resp?.zscore === 'number' && (
                    <span className="px-2 py-1 rounded-full bg-gray-100 border">
                      z: {resp.zscore.toFixed(2)}
                    </span>
                  )}
                  <span className="px-2 py-1 rounded-full bg-gray-100 border">
                    thr: {resp?.threshold ?? 0.5}
                  </span>
                </div>

                {/* Aviso de auto-reset */}
                <div className="text-xs text-gray-500 mt-3">
                  Reiniciando em 5 segundos…
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  }
  // Modo câmera: centralizado
  return (
    <div className="min-h-screen grid place-items-center px-4">
      <div className="flex flex-col items-center gap-3 w-full max-w-xl">
        <div
          ref={containerRef}
          className="w-full"
          style={{ position: 'relative' }}
        >
          <video
            ref={videoRef}
            style={{
              width: '100%',
              height: 'auto',
              display: 'block',
              transform: 'scaleX(-1)',
              borderRadius: 16,
              background: '#000',
            }}
            autoPlay
            muted
            playsInline
          />
          <canvas
            ref={overlayRef}
            style={{
              position: 'absolute',
              inset: 0,
              zIndex: 1,
              pointerEvents: 'none',
              transform: 'scaleX(-1)',
              borderRadius: 16,
            }}
          />
          <canvas ref={drawRef} style={{ display: 'none' }} />
        </div>

        <div className="text-sm text-gray-700">{status}</div>
      </div>
    </div>
  );
}

/* ===== helpers ===== */

function drawGuide(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number
) {
  const s = Math.min(width, height);
  const cx = GUIDE.centerX * width;
  const cy = GUIDE.centerY * height;
  const ry = GUIDE.targetRadius * s;
  const rx = ry * 0.8;

  ctx.save();
  ctx.fillStyle = 'rgba(0,0,0,0.35)';
  ctx.fillRect(0, 0, width, height);
  ctx.globalCompositeOperation = 'destination-out';
  ellipse(ctx, cx, cy, rx, ry);
  ctx.fill();
  ctx.restore();

  ctx.beginPath();
  ellipse(ctx, cx, cy, rx, ry);
  ctx.lineWidth = 3;

  return { cx, cy, rx, ry };
}

function drawStatus(
  ctx: CanvasRenderingContext2D,
  guide: { cx: number; cy: number; rx: number; ry: number },
  mood: FitFeedback,
  score?: number
) {
  const color =
    mood === 'good' ? '#22c55e' : mood === 'ok' ? '#fbbf24' : '#ef4444';
  ctx.strokeStyle = color;
  ctx.stroke();

  ctx.font = '14px system-ui';
  ctx.fillStyle = color;
  const pct = score != null ? ` (${Math.round(score * 100)}%)` : '';
  const tip =
    mood === 'good'
      ? 'Perfeito! Segure…'
      : mood === 'ok'
      ? 'Quase lá… ajuste um pouco'
      : 'Centralize o rosto';
  ctx.fillText(
    tip + pct,
    Math.max(10, guide.cx - 110),
    guide.cy + guide.ry + 22
  );
}

function ellipse(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  rx: number,
  ry: number
) {
  ctx.save();
  ctx.translate(cx, cy);
  ctx.scale(rx, ry);
  ctx.arc(0, 0, 1, 0, 2 * Math.PI);
  ctx.restore();
}

function fitFaceToGuide(
  det: faceapi.WithFaceDescriptor<
    faceapi.WithFaceLandmarks<{ detection: faceapi.FaceDetection }>
  >,
  videoW: number,
  videoH: number,
  guide: { cx: number; cy: number; rx: number; ry: number }
): {
  mood: FitFeedback;
  score: number;
} {
  const box = det.detection.box;
  const s = Math.min(videoW, videoH);
  const fx = box.x + box.width / 2;
  const fy = box.y + box.height / 2;
  const dist = Math.hypot(fx - guide.cx, fy - guide.cy);
  const posScore = clamp01(1 - dist / (GUIDE.posTol * s));
  const targetH = guide.ry * 2;
  const sizeErr = Math.abs(box.height - targetH);
  const sizeScore = clamp01(1 - sizeErr / (GUIDE.sizeTol * targetH));
  const lm = det.landmarks;
  const L = mean(lm.getLeftEye());
  const R = mean(lm.getRightEye());
  const angleDeg = (Math.atan2(R.y - L.y, R.x - L.x) * 180) / Math.PI;
  const angleScore = clamp01(1 - Math.abs(angleDeg) / GUIDE.angleTolDeg);
  const score = clamp01(0.45 * posScore + 0.35 * sizeScore + 0.2 * angleScore);
  const mood: FitFeedback =
    score >= 0.7 ? 'good' : score >= 0.45 ? 'ok' : 'bad';
  return { mood, score };
}

function clamp01(x: number) {
  return Math.max(0, Math.min(1, x));
}
function mean(pts: { x: number; y: number }[]) {
  const n = Math.max(pts.length, 1);
  return {
    x: pts.reduce((a, b) => a + b.x, 0) / n,
    y: pts.reduce((a, b) => a + b.y, 0) / n,
  };
}
