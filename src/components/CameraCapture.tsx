/* eslint-disable no-empty */

/* eslint-disable @typescript-eslint/no-explicit-any */
import { useEffect, useMemo, useRef, useState } from 'react';
import * as faceapi from '@vladmandic/face-api';
import Lottie from 'lottie-react';
import loadingAnim from '../assets/recognize_loading.json';
import { postMatch } from '../api';
import * as tf from '@tensorflow/tfjs';
import '@tensorflow/tfjs-backend-wasm';
import * as wasm from '@tensorflow/tfjs-backend-wasm';

const baseUrl = import.meta.env.BASE_URL + 'models';
const wasmBase = import.meta.env.BASE_URL + 'tfjs/';
const IS_RASPBERRY = import.meta.env.VITE_IS_RASPBERRY === 'true';
const isMobile = /Mobi|Android|iPhone|iPad/i.test(navigator.userAgent);
const GUIDE = {
  centerX: 0.5,
  centerY: 0.48,
  targetRadius: isMobile ? 0.35 : 0.35, // rosto ocupa % do menor lado do frame de VÍDEO
  posTol: isMobile ? 0.35 : 0.35, // tolerância de posição
  sizeTol: isMobile ? 0.45 : 0.45, // tolerância de tamanho
  angleTolDeg: isMobile ? 22 : 22, // tolerância de ângulo
};
const resetTime = 7000;

const RUN = {
  intervalMs: IS_RASPBERRY ? 150 : 100,
  lockConsecutive: IS_RASPBERRY ? 1 : 5, // quantos frames “good” para capturar
  minScore: 0.5, // score mínimo da detecção
  captureOnYellowAfter: IS_RASPBERRY ? 3 : 8, // captura se ficar “ok” por N frames
};

type FitFeedback = 'bad' | 'ok' | 'good';

export type MatchResp = {
  match: null | {
    id: string;
    name: string;
    email?: string;
    avatar_url?: string | null;
    distance: number;
  };
  nextAppointment?: {
    id: string;
    start_checkin: string;
    stop_checkin: string;
  };
  changedAppointment: 'start' | 'stop' | null;
  threshold: number;
  gap?: number;
  zscore?: number;
  bestDistance?: number;
};

export default function CameraAutoCapture() {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const overlayRef = useRef<HTMLCanvasElement | null>(null); // overlay visível (CSS px)
  const drawRef = useRef<HTMLCanvasElement | null>(null); // canvas de detecção (vídeo px)
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
  const previewContainerRef = useRef<HTMLDivElement | null>(null);
  const { ringSize, imgSize, inset } = useResponsiveRing(
    previewContainerRef.current
  );
  function useResponsiveRing(container?: HTMLElement | null) {
    const [ring, setRing] = useState({
      ringSize: (520 * 2) / 3,
      imgSize: (240 * 2) / 3,
      inset: (140 * 2) / 3,
    });

    useEffect(() => {
      if (!container) return;

      const ro = new ResizeObserver(() => {
        const w = container.clientWidth || window.innerWidth;
        const max = Math.min(w, 520); // limite superior
        const ringSize = Math.max(280, Math.floor(max * 0.9)); // mínimo 280px
        const imgSize = Math.floor(ringSize * 0.46); // ~46% do anel
        const inset = Math.floor((ringSize - imgSize) / 2);
        setRing({ ringSize, imgSize, inset });
      });

      ro.observe(container);
      return () => ro.disconnect();
    }, [container]);

    return ring;
  }

  useEffect(() => {
    let cancel = false;
    (async () => {
      try {
        // >>> 1) aponte onde estão os .wasm na sua build
        // coloque os .wasm em /public/tfjs/ (ver passo 2)

        wasm.setWasmPaths(wasmBase);

        // (opcionais) em aparelhos antigos / Electron sem COOP/COEP:
        try {
          tf.env().set('WASM_HAS_SIMD_SUPPORT', false);
          tf.env().set('WASM_HAS_THREADS_SUPPORT', false);
        } catch {}

        // >>> 2) ative WASM (fallback para CPU se falhar)
        try {
          await tf.setBackend('wasm');
        } catch {
          await tf.setBackend('cpu');
        }
        await tf.ready();
        console.log('Backend TFJS:', tf.getBackend());

        // >>> 3) só agora carregue os modelos
        await Promise.all([
          faceapi.nets.tinyFaceDetector.loadFromUri(baseUrl),
          faceapi.nets.faceLandmark68Net.loadFromUri(baseUrl),
          faceapi.nets.faceRecognitionNet.loadFromUri(baseUrl),
        ]);

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

  // 2) Abrir câmera quando modelos prontos
  useEffect(() => {
    if (!modelsReady) return;

    let pollId: number | null = null;
    const waitForVideoDims = async (video: HTMLVideoElement) => {
      let tries = 0;
      await new Promise<void>((resolve) => {
        const check = () => {
          tries++;
          if (video.videoWidth > 0 && video.videoHeight > 0) resolve();
          else if (tries > 80) resolve();
          else pollId = window.setTimeout(check, 50);
        };
        check();
      });
    };

    (async () => {
      try {
        setStatus('abrindo câmera…');

        if (!streamRef.current) {
          const videoConstraints = IS_RASPBERRY
            ? true
            : {
                facingMode: 'user',
                width: { ideal: 1280 },
                height: { ideal: 720 },
              };
          streamRef.current = await navigator.mediaDevices.getUserMedia({
            video: videoConstraints,
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
    };
  }, [modelsReady]);

  // 3) Fechar stream apenas ao desmontar
  useEffect(() => {
    return () => {
      if (streamRef.current) {
        streamRef.current.getTracks().forEach((t) => t.stop());
        streamRef.current = null;
      }
    };
  }, []);

  // 4) Se sair do preview (locked=false), garante que a câmera volta
  useEffect(() => {
    if (!locked && modelsReady) ensureCamera();
  }, [locked, modelsReady]);

  // 5) Auto-reset 5s após resposta
  useEffect(() => {
    if (locked && preview && resp && !loading) {
      const t = setTimeout(() => {
        handleReset();
      }, resetTime);
      return () => clearTimeout(t);
    }
  }, [locked, preview, resp, loading]);

  // 6) Overlay acompanha container
  useEffect(() => {
    if (!containerRef.current) return;
    const ro = new ResizeObserver(() => {
      syncSizes();
      if (cameraReady) setOverlayReady(true);
    });
    ro.observe(containerRef.current);
    return () => ro.disconnect();
  }, [cameraReady]);

  // === sincroniza tamanhos overlay/draw com vídeo ===
  function syncSizes() {
    const video = videoRef.current;
    const overlay = overlayRef.current;
    const draw = drawRef.current;
    if (!video || !overlay || !draw) return;

    const rect = video.getBoundingClientRect();

    // overlay (CSS px + HiDPI)
    overlay.style.width = `${rect.width}px`;
    overlay.style.height = `${rect.height}px`;
    const dpr = Math.max(1, window.devicePixelRatio || 1);
    overlay.width = Math.round(rect.width * dpr);
    overlay.height = Math.round(rect.height * dpr);
    const octx = overlay.getContext('2d')!;
    octx.setTransform(dpr, 0, 0, dpr, 0, 0);
    octx.clearRect(0, 0, rect.width, rect.height);

    // draw (vídeo px)
    draw.width = video.videoWidth || Math.round(rect.width * dpr);
    draw.height = video.videoHeight || Math.round(rect.height * dpr);
  }

  // === loop de detecção ===
  useEffect(() => {
    if (!appReady) return;

    const run = async () => {
      const video = videoRef.current;
      const overlay = overlayRef.current;
      const draw = drawRef.current;
      if (!video || !overlay || !draw || locked || video.readyState < 2) return;

      // garante sync se houver resize
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

      // desenha frame no canvas de detecção (vídeo px)
      dctx.setTransform(1, 0, 0, 1, 0, 0);
      dctx.drawImage(video, 0, 0, vw, vh);

      // guia calculado em VÍDEO, overlay desenhado escalado pra CSS
      const guideVideo = computeGuideVideo(vw, vh);

      octx.clearRect(0, 0, rect.width, rect.height);
      drawGuideOverlay(octx, rect.width, rect.height, vw, vh, guideVideo);

      const opts = new faceapi.TinyFaceDetectorOptions({
        inputSize: IS_RASPBERRY ? 160 : 416,
        scoreThreshold: 0.5,
      });
      const det = await faceapi
        .detectSingleFace(draw, opts)
        .withFaceLandmarks()
        .withFaceDescriptor();

      if (!det || (det.detection.score ?? 0) < RUN.minScore) {
        consecOk.current = 0;
        drawStatusOverlay(
          octx,
          rect.width,
          rect.height,
          vw,
          vh,
          guideVideo,
          'bad'
        );
        setStatus('posicione o rosto dentro da moldura');
        return;
      }

      const fit = fitFaceToGuide(det, vw, vh, guideVideo);
      drawStatusOverlay(
        octx,
        rect.width,
        rect.height,
        vw,
        vh,
        guideVideo,
        fit.mood,
        fit.score,
        fit.hint
      );

      // contador de frames bons
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
          setStatus(r.match ? 'reconhecido' : 'sem match');
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

    try {
      const videoConstraints = IS_RASPBERRY
        ? true
        : {
            facingMode: 'user',
            width: { ideal: 1280 },
            height: { ideal: 720 },
          };
      if (!streamRef.current) {
        streamRef.current = await navigator.mediaDevices.getUserMedia({
          video: videoConstraints,
          audio: false,
        });
      }
      video.srcObject = streamRef.current;
      video.muted = true;
      (video as any).playsInline = true;
      await video.play();
      if (video.videoWidth === 0 || video.videoHeight === 0) {
        await new Promise((r) => setTimeout(r, 60));
      }
      syncSizes();
      setCameraReady(true);
      setOverlayReady(true);
    } catch (err: any) {
      setStatus('erro câmera: ' + (err?.name || err?.message || String(err)));
    }
  }

  async function handleReset() {
    setLocked(false);
    setPreview(null);
    setResp(null);
    setLoading(false);
    consecOk.current = 0;
    setStatus('câmera pronta');
    await ensureCamera();
  }

  // ===== RENDER =====

  // Tela de carregamento centralizada até tudo ficar pronto
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

  // Preview com anel Lottie ao redor e cartão de resultado
  if (locked && preview) {
    const m = resp?.match;
    const appointment = resp?.nextAppointment;
    const showMatch = Boolean(m);
    const dist = m?.distance ?? resp?.bestDistance;
    const cardBgClasses = `w-full max-w-2xl rounded-2xl border shadow-sm p-5 ${
      !m ? 'bg-red-50' : appointment ? 'bg-green-50' : 'bg-yellow-50'
    }`;

    return (
      <div className="min-h-screen grid place-items-center px-4">
        <div
          ref={previewContainerRef}
          className="flex flex-col items-center gap-8 w-full max-w-4xl"
        >
          {!resp && (
            <div
              className="relative"
              style={{ width: ringSize, height: ringSize }}
            >
              {/* Lottie por trás, ocupando 100% do container */}
              {!IS_RASPBERRY && (
                <Lottie
                  animationData={loadingAnim}
                  loop
                  autoplay
                  style={{
                    position: 'absolute',
                    inset: 0,
                    width: '100%',
                    height: '100%',
                    pointerEvents: 'none',
                    zIndex: 1,
                  }}
                  // 'meet' preserva a animação inteira dentro do quadrado em telas menores
                  rendererSettings={{ preserveAspectRatio: 'xMidYMid meet' }}
                />
              )}
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
                  zIndex: 2,
                }}
              />
            </div>
          )}

          {/* Cartão de resultado */}
          <div className={cardBgClasses}>
            <div className="flex flex-col items-center">
              {resp?.changedAppointment === 'start' ? (
                <h2 className="text-green-700 font-semibold">
                  Entrada Registrada!
                </h2>
              ) : resp?.changedAppointment === 'stop' ? (
                <h2 className="text-yellow-700 font-semibold">
                  Saída Registrada!
                </h2>
              ) : null}

              <div
                className="rounded-full overflow-hidden border shadow"
                style={{ width: (240 * 2) / 3, height: (240 * 2) / 3 }}
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

            <div className="flex items-start gap-4 mt-4">
              <div className="flex-1">
                <div className="text-sm text-gray-600 mb-1">
                  {resp?.match ? 'Reconhecido' : 'Não reconhecido'}
                </div>
                {showMatch ? (
                  <div className="text-xl font-semibold">{m?.name}</div>
                ) : (
                  <div className="text-xl font-semibold">Sem match</div>
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
                  {appointment ? (
                    <>
                      <span className="px-2 py-1 rounded-full bg-gray-100 border">
                        Próxima rotina
                      </span>
                      <span className="px-2 py-1 rounded-full bg-gray-100 border">
                        entrada:{' '}
                        {new Date(appointment.start_checkin).toLocaleString(
                          'pt-BR',
                          {
                            day: '2-digit',
                            month: '2-digit',
                            year: 'numeric',
                            hour: '2-digit',
                            minute: '2-digit',
                          }
                        )}
                      </span>
                      <span className="px-2 py-1 rounded-full bg-gray-100 border">
                        saída:{' '}
                        {new Date(appointment.stop_checkin).toLocaleString(
                          'pt-BR',
                          {
                            day: '2-digit',
                            month: '2-digit',
                            year: 'numeric',
                            hour: '2-digit',
                            minute: '2-digit',
                          }
                        )}
                      </span>
                    </>
                  ) : (
                    <span className="px-2 py-1 rounded-full bg-gray-100 border">
                      sem rotina
                    </span>
                  )}
                </div>

                <div className="text-xs text-gray-500 mt-3">
                  Reiniciando em {resetTime / 1000} segundos…
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // Modo câmera centralizado
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
            className="w-full h-auto rounded-xl bg-black"
            style={{
              display: 'block',
              transform: 'scaleX(-1)', // efeito "espelho"
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
              // transform: 'scaleX(-1)', // overlay espelhado igual ao vídeo
              borderRadius: 12,
            }}
          />
          <canvas ref={drawRef} style={{ display: 'none' }} />
        </div>

        <div className="text-sm text-gray-700">{status}</div>
      </div>
    </div>
  );
}

/* ===== Helpers (vídeo-space guide + overlay escalado) ===== */

function computeGuideVideo(videoW: number, videoH: number) {
  const s = Math.min(videoW, videoH);
  const cx = GUIDE.centerX * videoW;
  const cy = GUIDE.centerY * videoH;
  const ry = GUIDE.targetRadius * s;
  const rx = ry * 0.8;
  return { cx, cy, rx, ry };
}

function drawGuideOverlay(
  ctx: CanvasRenderingContext2D,
  cssW: number,
  cssH: number,
  videoW: number,
  videoH: number,
  guide: { cx: number; cy: number; rx: number; ry: number }
) {
  const sx = cssW / videoW;
  const sy = cssH / videoH;

  const cx = guide.cx * sx;
  const cy = guide.cy * sy;
  const rx = guide.rx * sx;
  const ry = guide.ry * sy;

  ctx.save();
  ctx.fillStyle = 'rgba(0,0,0,0.35)';
  ctx.fillRect(0, 0, cssW, cssH);
  ctx.globalCompositeOperation = 'destination-out';
  ellipse(ctx, cx, cy, rx, ry);
  ctx.fill();
  ctx.restore();

  ctx.beginPath();
  ellipse(ctx, cx, cy, rx, ry);
  ctx.lineWidth = 3;
}

function drawStatusOverlay(
  ctx: CanvasRenderingContext2D,
  cssW: number,
  cssH: number,
  videoW: number,
  videoH: number,
  guide: { cx: number; cy: number; rx: number; ry: number },
  mood: FitFeedback,
  score?: number,
  hint?: string
) {
  const sx = cssW / videoW;
  const sy = cssH / videoH;

  const cx = guide.cx * sx;
  const cy = guide.cy * sy;
  // const rx = guide.rx * sx;
  const ry = guide.ry * sy;

  const color =
    mood === 'good' ? '#22c55e' : mood === 'ok' ? '#fbbf24' : '#ef4444';
  ctx.strokeStyle = color;
  ctx.stroke();

  ctx.font = '14px system-ui';
  ctx.fillStyle = color;
  const pct = score != null ? ` (${Math.round(score * 100)}%)` : '';
  const tip =
    hint ||
    (mood === 'good'
      ? 'Perfeito! Segure…'
      : mood === 'ok'
      ? 'Quase lá… ajuste um pouco'
      : 'Centralize o rosto');

  ctx.fillText(tip + pct, Math.max(10, cx - 110), cy + ry + 22);
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
): { mood: FitFeedback; score: number; hint?: string } {
  const box = det.detection.box; // px de VÍDEO
  const s = Math.min(videoW, videoH);

  const fx = box.x + box.width / 2;
  const fy = box.y + box.height / 2;

  // 1) posição
  const dist = Math.hypot(fx - guide.cx, fy - guide.cy);
  const posScore = clamp01(1 - dist / (GUIDE.posTol * s));

  // 2) tamanho
  const targetH = guide.ry * 2;
  const sizeErr = box.height - targetH; // >0: muito perto; <0: muito longe
  const sizeScore = clamp01(1 - Math.abs(sizeErr) / (GUIDE.sizeTol * targetH));

  // 3) ângulo
  const lm = det.landmarks;
  const L = mean(lm.getLeftEye());
  const R = mean(lm.getRightEye());
  const angleDeg = (Math.atan2(R.y - L.y, R.x - L.x) * 180) / Math.PI;
  const angleScore = clamp01(1 - Math.abs(angleDeg) / GUIDE.angleTolDeg);

  // pesos
  const wPos = 0.45,
    wSize = 0.35,
    wAngle = 0.2;
  const score = clamp01(
    wPos * posScore + wSize * sizeScore + wAngle * angleScore
  );

  // dicas
  let hint: string | undefined;
  if (Math.abs(sizeErr) > GUIDE.sizeTol * targetH * 0.6) {
    hint = sizeErr > 0 ? 'Afastar um pouco' : 'Chegar um pouco mais perto';
  } else if (posScore < 0.45) {
    const dx = fx - guide.cx;
    const dy = fy - guide.cy;
    // se quiser que esquerda/direita considerem o preview espelhado, inverta dx aqui:
    // const dxMirror = -dx;
    if (Math.abs(dx) > Math.abs(dy)) {
      hint =
        dx > 0
          ? 'Mova um pouco para a direita'
          : 'Mova um pouco para a esquerda';
    } else {
      hint = dy > 0 ? 'Mova um pouco para baixo' : 'Mova um pouco para cima';
    }
  } else if (angleScore < 0.5) {
    hint =
      angleDeg > 0 ? 'Nivele a cabeça à direita' : 'Nivele a cabeça à esquerda';
  }

  const mood: FitFeedback =
    score >= 0.7 ? 'good' : score >= 0.45 ? 'ok' : 'bad';
  return { mood, score, hint };
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
