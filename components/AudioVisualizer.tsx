"use client";

import { useRef, useEffect, useCallback } from "react";

interface AudioVisualizerProps {
  audioRef: React.RefObject<HTMLAudioElement | null>;
  hostRef?: React.RefObject<HTMLElement | null>;
  playing: boolean;
  barCount?: number;
  className?: string;
  mode?: "bars" | "waveBackdrop";
}

let sharedContext: AudioContext | null = null;

function getAudioContext(): AudioContext {
  if (!sharedContext || sharedContext.state === "closed") {
    sharedContext = new AudioContext();
  }
  return sharedContext;
}

const sourceMap = new WeakMap<HTMLAudioElement, MediaElementAudioSourceNode>();
const destinationMap = new WeakSet<HTMLAudioElement>();

export default function AudioVisualizer({
  audioRef,
  hostRef,
  playing,
  barCount = 32,
  className = "",
  mode = "bars",
}: AudioVisualizerProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const rafRef = useRef<number>(0);
  const connectedRef = useRef(false);
  const bassEnvelopeRef = useRef(0);
  const lastBassRef = useRef(0);
  const kickHitRef = useRef(0);
  const phaseRef = useRef(0);
  const kickWaveXRef = useRef(0);
  const kickWaveYRef = useRef(0);
  const smoothBarsRef = useRef<Float32Array | null>(null);

  function mixColor(base: [number, number, number], art: [number, number, number], artWeight: number): [number, number, number] {
    const w = Math.max(0, Math.min(1, artWeight));
    const inv = 1 - w;
    return [
      Math.round(base[0] * inv + art[0] * w),
      Math.round(base[1] * inv + art[1] * w),
      Math.round(base[2] * inv + art[2] * w),
    ];
  }

  const connect = useCallback(() => {
    const audio = audioRef.current;
    if (!audio || connectedRef.current) return;

    try {
      const ctx = getAudioContext();
      if (ctx.state === "suspended") ctx.resume();

      let source = sourceMap.get(audio);
      if (!source) {
        source = ctx.createMediaElementSource(audio);
        sourceMap.set(audio, source);
      }

      const analyser = ctx.createAnalyser();
      analyser.fftSize = 256;
      analyser.smoothingTimeConstant = 0.8;

      source.connect(analyser);
      if (!destinationMap.has(audio)) {
        source.connect(ctx.destination);
        destinationMap.add(audio);
      }

      analyserRef.current = analyser;
      connectedRef.current = true;
    } catch {
      // CORS or browser restriction — visualizer won't work but audio still plays
    }
  }, [audioRef]);

  useEffect(() => {
    if (playing && !connectedRef.current) {
      connect();
    }
  }, [playing, connect]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const analyser = analyserRef.current;
    if (!canvas || !analyser || !playing) {
      cancelAnimationFrame(rafRef.current);
      bassEnvelopeRef.current = 0;
      lastBassRef.current = 0;
      kickHitRef.current = 0;
      phaseRef.current = 0;
      smoothBarsRef.current = null;
      if (hostRef?.current) {
        hostRef.current.style.setProperty("--player-bass", "0");
        hostRef.current.style.setProperty("--kick-hit", "0");
        hostRef.current.style.setProperty("--kick-phase", "0");
        hostRef.current.style.setProperty("--kick-wave", "0");
        hostRef.current.style.setProperty("--kick-wave-x", "0");
        hostRef.current.style.setProperty("--kick-wave-y", "0");
      }
      return;
    }

    const ctx2d = canvas.getContext("2d");
    if (!ctx2d) return;

    const dataArray = new Uint8Array(analyser.frequencyBinCount);
    const timeArray = new Uint8Array(analyser.fftSize);
    const usableBins = Math.min(barCount, analyser.frequencyBinCount);
    smoothBarsRef.current = new Float32Array(usableBins);

    function draw() {
      if (!canvas || !ctx2d || !analyser) return;

      const dpr = window.devicePixelRatio || 1;
      const rect = canvas.getBoundingClientRect();
      const w = rect.width * dpr;
      const h = rect.height * dpr;

      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
      }

      analyser.getByteFrequencyData(dataArray);
      analyser.getByteTimeDomainData(timeArray);
      ctx2d.clearRect(0, 0, w, h);

      let artR = 139;
      let artG = 92;
      let artB = 246;
      if (hostRef?.current) {
        const style = getComputedStyle(hostRef.current);
        artR = Number(style.getPropertyValue("--player-art-r").trim()) || 139;
        artG = Number(style.getPropertyValue("--player-art-g").trim()) || 92;
        artB = Number(style.getPropertyValue("--player-art-b").trim()) || 246;
      }
      const artColor: [number, number, number] = [artR, artG, artB];
      const basePurple: [number, number, number] = [139, 92, 246];
      const baseLight: [number, number, number] = [196, 181, 253];
      const basePink: [number, number, number] = [236, 72, 153];
      const tintMid = mixColor(basePurple, artColor, 0.22);
      const tintLight = mixColor(baseLight, artColor, 0.26);
      const tintHot = mixColor(basePink, artColor, 0.2);

      // Smooth envelope to avoid stroboscopic jumps.
      const bassRaw = (dataArray[1] + dataArray[2] + dataArray[3] + dataArray[4]) / (4 * 255);
      const env = bassEnvelopeRef.current;
      const nextEnv = env + (bassRaw - env) * (bassRaw > env ? 0.14 : 0.05);
      bassEnvelopeRef.current = nextEnv;
      const delta = bassRaw - lastBassRef.current;
      lastBassRef.current = bassRaw;
      const kickRaw = Math.max(0, delta * 5.5 + nextEnv * 0.28);
      const nextKickHit = kickHitRef.current + (kickRaw - kickHitRef.current) * 0.12;
      kickHitRef.current = nextKickHit;
      // Sinus oscillator follows kick, but phase and amplitude stay continuous.
      phaseRef.current += 0.055 + nextEnv * 0.11 + nextKickHit * 0.12;
      if (phaseRef.current > 10000) phaseRef.current = phaseRef.current % 10000;
      const targetWaveX = Math.sin(phaseRef.current) * (0.08 + nextKickHit * 0.32 + nextEnv * 0.16);
      const targetWaveY = Math.sin(phaseRef.current * 0.6 + Math.PI * 0.35) * (0.05 + nextEnv * 0.2);
      kickWaveXRef.current += (targetWaveX - kickWaveXRef.current) * 0.08;
      kickWaveYRef.current += (targetWaveY - kickWaveYRef.current) * 0.07;
      const waveEnergy = Math.min(1, nextEnv * 0.55 + Math.abs(kickWaveXRef.current) * 0.3);

      if (hostRef?.current) {
        hostRef.current.style.setProperty("--player-bass", nextEnv.toFixed(3));
        hostRef.current.style.setProperty("--kick-hit", nextKickHit.toFixed(3));
        hostRef.current.style.setProperty("--kick-phase", phaseRef.current.toFixed(2));
        hostRef.current.style.setProperty("--kick-wave", waveEnergy.toFixed(3));
        hostRef.current.style.setProperty("--kick-wave-x", kickWaveXRef.current.toFixed(3));
        hostRef.current.style.setProperty("--kick-wave-y", kickWaveYRef.current.toFixed(3));
      }

      if (mode === "waveBackdrop") {
        const cols = Math.max(32, Math.min(68, Math.floor(w / (18 * dpr))));
        const rows = Math.max(12, Math.min(24, Math.floor(h / (12 * dpr))));
        if (!smoothBarsRef.current || smoothBarsRef.current.length !== cols) {
          smoothBarsRef.current = new Float32Array(cols);
        }
        const smoothCols = smoothBarsRef.current;
        const colStep = w / (cols - 1);
        const rowStep = h / (rows - 1);
        const xShift = kickWaveXRef.current * 8 * dpr;
        const yDrift = kickWaveYRef.current * 6 * dpr;
        const time = phaseRef.current * 0.3;

        // Subtle gradient backdrop
        const bg = ctx2d.createRadialGradient(w * 0.3, h * 0.6, 0, w * 0.7, h * 0.4, Math.max(w, h) * 0.8);
        bg.addColorStop(0, `rgba(${tintMid[0]}, ${tintMid[1]}, ${tintMid[2]}, 0.08)`);
        bg.addColorStop(0.6, `rgba(${tintHot[0]}, ${tintHot[1]}, ${tintHot[2]}, 0.04)`);
        bg.addColorStop(1, `rgba(${tintLight[0]}, ${tintLight[1]}, ${tintLight[2]}, 0.02)`);
        ctx2d.fillStyle = bg;
        ctx2d.fillRect(0, 0, w, h);

        for (let c = 0; c < cols; c++) {
          const binCenter = Math.floor((c / cols) * (usableBins - 1));
          let binSum = 0;
          let binCount = 0;
          for (let b = Math.max(0, binCenter - 1); b <= Math.min(usableBins - 1, binCenter + 1); b++) {
            binSum += dataArray[b];
            binCount++;
          }
          const raw = (binSum / Math.max(1, binCount)) / 255;
          const prev = smoothCols[c] ?? raw;
          const smooth = prev + (raw - prev) * (raw > prev ? 0.12 : 0.05);
          smoothCols[c] = smooth;
          
          const x = c * colStep + xShift;
          const colPulse = 0.4 + 0.6 * Math.sin(time * 1.2 + c * 0.28);
          const colEnergy = smooth * 0.72 + nextEnv * 0.28;

          for (let r = 0; r < rows; r++) {
            const y = r * rowStep + yDrift;
            const rowPos = r / Math.max(1, rows - 1);
            const colPos = c / Math.max(1, cols - 1);
            
            // Multi-layered wave patterns
            const wave1 = 0.5 + Math.sin(time * 0.8 + colPos * Math.PI * 2.4) * 0.3;
            const wave2 = 0.5 + Math.sin(time * 1.1 + rowPos * Math.PI * 1.8 + colPos * Math.PI * 0.6) * 0.2;
            const waveCenter = (wave1 + wave2) * 0.5;
            const dist = Math.abs(rowPos - waveCenter);
            const band = Math.max(0, 1 - dist * 2.8);
            
            const motion = 0.6 + 0.4 * Math.sin(time * 0.9 + r * 0.6 + c * 0.18);
            const centerBoost = 1 - Math.abs(colPos - 0.5) * 0.4;
            const intensity = Math.min(1, band * (colEnergy * 0.85 + colPulse * 0.15) * motion * centerBoost + waveEnergy * 0.12);
            
            if (intensity < 0.08) continue;

            // Varied shapes based on position and intensity
            const shapeType = (c + r * 3) % 5;
            const baseSize = (1.2 + intensity * 2.4) * dpr;
            const sizeVariation = 0.8 + 0.4 * Math.sin(time * 1.4 + c * 0.5 + r * 0.3);
            const finalSize = baseSize * sizeVariation;
            
            // Dynamic color based on frequency and position
            const hue = (colPos * 0.15 + intensity * 0.1 + time * 0.02) % 1;
            const colorMix = hue * 0.6 + 0.4;
            const alpha = Math.min(0.72, 0.08 + intensity * 0.64);
            
            const baseR = Math.floor(226 * (1 - colorMix) + 196 * colorMix);
            const baseG = Math.floor(232 * (1 - colorMix) + 181 * colorMix);
            const baseB = Math.floor(240 * (1 - colorMix) + 253 * colorMix);
            const mixed = mixColor([baseR, baseG, baseB], artColor, 0.24);
            
            // Shape rendering with organic variations
            const offsetX = Math.sin(time * 0.7 + c * 0.4) * 2 * dpr * intensity;
            const offsetY = Math.cos(time * 0.5 + r * 0.6) * 1.5 * dpr * intensity;
            const px = x + offsetX;
            const py = y + offsetY;
            
            ctx2d.fillStyle = `rgba(${mixed[0]}, ${mixed[1]}, ${mixed[2]}, ${alpha})`;
            
            if (shapeType === 0 || shapeType === 4) {
              // Circles with size variation
              ctx2d.beginPath();
              ctx2d.arc(px, py, finalSize * 0.5, 0, Math.PI * 2);
              ctx2d.fill();
            } else if (shapeType === 1) {
              // Rounded rectangles
              const w = finalSize * 0.8;
              const h = finalSize * 1.4;
              ctx2d.beginPath();
              ctx2d.roundRect(px - w/2, py - h/2, w, h, Math.min(w, h) * 0.3);
              ctx2d.fill();
            } else if (shapeType === 2) {
              // Diamonds
              const s = finalSize * 0.6;
              ctx2d.beginPath();
              ctx2d.moveTo(px, py - s);
              ctx2d.lineTo(px + s, py);
              ctx2d.lineTo(px, py + s);
              ctx2d.lineTo(px - s, py);
              ctx2d.closePath();
              ctx2d.fill();
            } else {
              // Small pills
              const w = finalSize * 0.5;
              const h = finalSize * 2.2;
              ctx2d.beginPath();
              ctx2d.roundRect(px - w/2, py - h/2, w, h, w);
              ctx2d.fill();
            }

            // Enhanced glow for high-intensity elements
            if (intensity > 0.35) {
              const glowR = (3 + intensity * 8) * dpr;
              const glow = ctx2d.createRadialGradient(px, py, 0, px, py, glowR);
              const glowAlpha = Math.min(0.4, intensity * 0.5);
              glow.addColorStop(0, `rgba(${tintLight[0]}, ${tintLight[1]}, ${tintLight[2]}, ${glowAlpha})`);
              glow.addColorStop(0.7, `rgba(${tintMid[0]}, ${tintMid[1]}, ${tintMid[2]}, ${glowAlpha * 0.3})`);
              glow.addColorStop(1, `rgba(${tintMid[0]}, ${tintMid[1]}, ${tintMid[2]}, 0)`);
              ctx2d.fillStyle = glow;
              ctx2d.beginPath();
              ctx2d.arc(px, py, glowR, 0, Math.PI * 2);
              ctx2d.fill();
            }
          }
        }
      } else {
        const gap = 1.5 * dpr;
        const totalGaps = (usableBins - 1) * gap;
        const barWidth = Math.max(1, (w - totalGaps) / usableBins);
        const radius = Math.min(barWidth / 2, 2 * dpr);
        const smoothBars = smoothBarsRef.current;

        for (let i = 0; i < usableBins; i++) {
          const raw = dataArray[i] / 255;
          const prev = smoothBars ? smoothBars[i] : raw;
          const rise = prev + (raw - prev) * 0.28;
          const fall = prev * 0.94;
          const smooth = raw > prev ? rise : Math.max(raw, fall);
          if (smoothBars) smoothBars[i] = smooth;
          const value = smooth * 0.9 + nextEnv * 0.1;
          const barHeight = Math.max(2 * dpr, value * h * 0.95);
          const x = i * (barWidth + gap);
          const y = h - barHeight;

          const alpha = 0.35 + value * 0.5;
          const gradient = ctx2d.createLinearGradient(0, y, 0, h);
          gradient.addColorStop(0, `rgba(${tintLight[0]}, ${tintLight[1]}, ${tintLight[2]}, ${Math.min(0.95, alpha + 0.2)})`);
          gradient.addColorStop(1, `rgba(${tintMid[0]}, ${tintMid[1]}, ${tintMid[2]}, ${alpha})`);
          ctx2d.fillStyle = gradient;

          ctx2d.beginPath();
          ctx2d.moveTo(x + radius, y);
          ctx2d.lineTo(x + barWidth - radius, y);
          ctx2d.quadraticCurveTo(x + barWidth, y, x + barWidth, y + radius);
          ctx2d.lineTo(x + barWidth, h);
          ctx2d.lineTo(x, h);
          ctx2d.lineTo(x, y + radius);
          ctx2d.quadraticCurveTo(x, y, x + radius, y);
          ctx2d.fill();
        }
      }

      rafRef.current = requestAnimationFrame(draw);
    }

    rafRef.current = requestAnimationFrame(draw);

    return () => {
      cancelAnimationFrame(rafRef.current);
      bassEnvelopeRef.current = 0;
      lastBassRef.current = 0;
      kickHitRef.current = 0;
      phaseRef.current = 0;
      kickWaveXRef.current = 0;
      kickWaveYRef.current = 0;
      if (hostRef?.current) {
        hostRef.current.style.setProperty("--player-bass", "0");
        hostRef.current.style.setProperty("--kick-hit", "0");
        hostRef.current.style.setProperty("--kick-phase", "0");
        hostRef.current.style.setProperty("--kick-wave", "0");
        hostRef.current.style.setProperty("--kick-wave-x", "0");
        hostRef.current.style.setProperty("--kick-wave-y", "0");
      }
    };
  }, [playing, barCount, hostRef, mode]);

  return (
    <canvas
      ref={canvasRef}
      className={`pointer-events-none w-full ${className}`}
    />
  );
}
