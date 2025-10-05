/* eslint-disable @typescript-eslint/no-explicit-any */
import { useEffect, useRef, useState } from 'react';
import * as faceapi from '@vladmandic/face-api';
import { postMatch } from '../api';

// 👇 SIRVA os modelos em /public/models e use esta base
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

export default function CameraAutoCapture() {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const overlayRef = useRef<HTMLCanvasElement | null>(null);
  const drawRef = useRef<HTMLCanvasElement | null>(null);

  const [status, setStatus] = useState('iniciando…');
  const [preview, setPreview] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const [locked, setLocked] = useState(false);

  const consecOk = useRef(0);
  const loopId = useRef<number | null>(null);
  const modelsReady = useRef(false);

  // Carregar modelos
  useEffect(() => {
    let cancel = false;
    (async () => {
      await faceapi.nets.tinyFaceDetector.loadFromUri(baseUrl);
      await faceapi.nets.faceLandmark68Net.loadFromUri(baseUrl);
      await faceapi.nets.faceRecognitionNet.loadFromUri(baseUrl);
      if (!cancel) {
        modelsReady.current = true;
        setStatus('modelos prontos');
      }
    })().catch((e) => setStatus('erro modelos: ' + (e?.message ?? e)));
    return () => {
      cancel = true;
    };
  }, []);

  // Abrir câmera
  useEffect(() => {
    let stream: MediaStream | null = null;
    (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: 'user' },
          audio: false,
        });
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          await videoRef.current.play();
          setStatus('câmera pronta');
          syncSizes();
        }
      } catch (e: any) {
        setStatus('erro câmera: ' + (e?.message ?? e));
      }
    })();
    return () => stream?.getTracks().forEach((t) => t.stop());
  }, []);

  // Sync overlay = vídeo
  useEffect(() => {
    if (!containerRef.current) return;
    const ro = new ResizeObserver(() => syncSizes());
    ro.observe(containerRef.current);
    return () => ro.disconnect();
  }, []);

  function syncSizes() {
    const video = videoRef.current,
      overlay = overlayRef.current,
      draw = drawRef.current;
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

  // Loop
  useEffect(() => {
    const run = async () => {
      const video = videoRef.current,
        overlay = overlayRef.current,
        draw = drawRef.current;
      if (
        !video ||
        !overlay ||
        !draw ||
        !modelsReady.current ||
        locked ||
        video.readyState < 2
      )
        return;

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

      // Atualiza contador de frames bons
      if (fit.mood === 'good') {
        consecOk.current++;
      } else if (fit.mood === 'ok') {
        if (RUN.captureOnYellowAfter) consecOk.current++;
      } else {
        consecOk.current = 0;
      }

      // Limiar para capturar (verde rápido, amarelo após N frames)
      const need =
        fit.mood === 'good'
          ? RUN.lockConsecutive
          : RUN.captureOnYellowAfter || 9999;
      if (consecOk.current >= need) {
        // 🔴 AQUI CAPTURA (não incremente mais!)
        consecOk.current = 0; // trava contador
        setLocked(true);
        setStatus('capturando…');

        const descriptor = Array.from(det.descriptor);
        const photo = draw.toDataURL('image/jpeg', 0.9);
        setPreview(photo);

        try {
          const resp = await postMatch(descriptor);
          if (resp.match) {
            setResult(
              `✅ ${resp.match.name} (dist: ${resp.match.distance.toFixed(
                3
              )} | thr: ${resp.threshold})`
            );
            setStatus('reconhecido');
          } else {
            setResult(
              `❌ não reconhecido (bestDist: ${
                resp.bestDistance?.toFixed(3) ?? 'n/a'
              } | thr: ${resp.threshold})`
            );
            setStatus('sem match');
          }
        } catch (e: any) {
          setStatus('erro no match: ' + (e?.message ?? e));
        }
        return;
      }

      setStatus(`ajuste o rosto — ${consecOk.current}/${need}`);
    };

    loopId.current = window.setInterval(run, RUN.intervalMs);
    return () => {
      if (loopId.current) window.clearInterval(loopId.current);
    };
  }, [locked]);

  function handleReset() {
    setLocked(false);
    setPreview(null);
    setResult(null);
    consecOk.current = 0;
    setStatus('câmera pronta');
    syncSizes();
  }

  return (
    <div className="flex flex-col items-center gap-3">
      <div
        ref={containerRef}
        style={{ position: 'relative', width: '100%', maxWidth: 520 }}
      >
        <video
          ref={videoRef}
          style={{
            width: '100%',
            height: 'auto',
            display: 'block',
            transform: 'scaleX(-1)',
            borderRadius: 12,
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
            borderRadius: 12,
          }}
        />
        <canvas ref={drawRef} style={{ display: 'none' }} />
      </div>

      <div className="text-sm text-gray-700">{status}</div>
      {preview && (
        <img
          src={preview}
          alt="captura"
          className="w-48 h-auto rounded-lg shadow border"
        />
      )}
      {result && <div className="text-lg font-semibold">{result}</div>}

      <button
        onClick={handleReset}
        className="px-4 py-2 rounded bg-gray-200 hover:bg-gray-300"
      >
        Reiniciar
      </button>
    </div>
  );
}

// ===== helpers =====
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
  parts: { pos: number; size: number; angle: number };
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

  const wPos = 0.45,
    wSize = 0.35,
    wAngle = 0.2;
  const score = clamp01(
    wPos * posScore + wSize * sizeScore + wAngle * angleScore
  );

  const mood: FitFeedback =
    score >= 0.7 ? 'good' : score >= 0.45 ? 'ok' : 'bad';
  return {
    mood,
    score,
    parts: { pos: posScore, size: sizeScore, angle: angleScore },
  };
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
