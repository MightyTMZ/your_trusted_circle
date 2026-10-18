import { useEffect, useRef } from 'react';
import type { CSSProperties, ReactNode } from 'react';

interface SafetyNetProps {
  height?: number | string;
  className?: string;
  style?: CSSProperties;
}

interface Point {
  x: number;
  y: number;
  dx: number;
  dy: number;
  vx: number;
  vy: number;
}

/**
 * Animated grid mesh that responds to pointer interaction.
 * Uses the theme's accent colour so it works in both Mono and Onyx.
 */
export function SafetyNet({ height = 320, className = '', style }: SafetyNetProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // Read the accent colour from the current theme tokens.
    const computed = getComputedStyle(canvas);
    const accent = computed.getPropertyValue('--accent').trim() || '#ffffff';

    // Parse the accent into r,g,b for rgba strings.
    let r = 128, g = 128, b = 128;
    if (accent.startsWith('#')) {
      const hex = accent.replace('#', '');
      r = parseInt(hex.substring(0, 2), 16);
      g = parseInt(hex.substring(2, 4), 16);
      b = parseInt(hex.substring(4, 6), 16);
    }

    const spacing = 24;
    let w = 0;
    let h = 0;
    let cols = 0;
    let rows = 0;
    let points: Point[] = [];

    let mouseX = -1000;
    let mouseY = -1000;
    let inside = false;
    let pressed = false;
    let animationId = 0;
    let running = false;

    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    function resize() {
      if (!canvas || !ctx) return;
      const rect = canvas.getBoundingClientRect();
      w = rect.width;
      h = rect.height;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

      cols = Math.ceil(w / spacing) + 2;
      rows = Math.ceil(h / spacing) + 2;
      points = [];
      for (let y = 0; y < rows; y++) {
        for (let x = 0; x < cols; x++) {
          points.push({ x: x * spacing - spacing, y: y * spacing - spacing, dx: 0, dy: 0, vx: 0, vy: 0 });
        }
      }
    }

    function getPoint(x: number, y: number) {
      return points[y * cols + x];
    }

    function update() {
      const time = performance.now() * 0.001;
      for (const point of points) {
        const distance = Math.hypot(point.x - mouseX, point.y - mouseY);
        const radius = pressed ? 155 : 110;
        const impact = inside ? Math.exp(-(distance * distance) / (2 * radius * radius)) : 0;
        const strength = pressed ? 49 : 13;

        const targetX = (mouseX - point.x) * impact * (pressed ? 0.15 : 0.045);
        const targetY = reducedMotion
          ? 0
          : strength * impact + Math.sin(time * 1.3 + point.x * 0.011 + point.y * 0.013) * 1.3;

        point.vx = (point.vx + (targetX - point.dx) * 0.07) * 0.84;
        point.vy = (point.vy + (targetY - point.dy) * 0.07) * 0.84;
        point.dx += point.vx;
        point.dy += point.vy;
      }
    }

    function draw() {
      if (!ctx) return;
      ctx.clearRect(0, 0, w, h);

      for (let y = 0; y < rows - 1; y++) {
        for (let x = 0; x < cols - 1; x++) {
          const a = getPoint(x, y);
          const b = getPoint(x + 1, y);
          const c = getPoint(x + 1, y + 1);
          const d = getPoint(x, y + 1);

          const local = Math.max(0, 1 - Math.hypot(a.x - mouseX, a.y - mouseY) / 240);
          const opacity = 0.1 + local * (pressed ? 0.32 : 0.16);

          ctx.strokeStyle = `rgba(${r},${g},${b},${opacity})`;
          ctx.lineWidth = pressed ? 1.05 : 0.85;

          ctx.beginPath();
          ctx.moveTo(a.x + a.dx, a.y + a.dy);
          ctx.lineTo(b.x + b.dx, b.y + b.dy);
          ctx.lineTo(c.x + c.dx, c.y + c.dy);
          ctx.lineTo(d.x + d.dx, d.y + d.dy);
          ctx.closePath();
          ctx.stroke();
        }
      }

      for (const point of points) {
        const depth = Math.min(1, Math.abs(point.dy) / 45);
        ctx.beginPath();
        ctx.arc(point.x + point.dx, point.y + point.dy, 1 + depth * 1.2, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(${r},${g},${b},${0.16 + depth * 0.4})`;
        ctx.fill();
      }
    }

    function animate() {
      if (!running) return;
      update();
      draw();
      animationId = requestAnimationFrame(animate);
    }

    function start() {
      if (running) return;
      running = true;
      animate();
    }

    function stop() {
      running = false;
      cancelAnimationFrame(animationId);
    }

    function movePointer(event: PointerEvent) {
      if (!canvas) return;
      const rect = canvas.getBoundingClientRect();
      mouseX = event.clientX - rect.left;
      mouseY = event.clientY - rect.top;
      inside = true;
    }

    function pointerDown(event: PointerEvent) {
      if (!canvas) return;
      pressed = true;
      movePointer(event);
      canvas.setPointerCapture(event.pointerId);
      canvas.style.cursor = 'grabbing';
    }

    function pointerUp() {
      if (!canvas) return;
      pressed = false;
      canvas.style.cursor = 'grab';
    }

    function pointerLeave() {
      if (!pressed) inside = false;
    }

    function visibilityChange() {
      if (document.hidden) stop();
      else if (!reducedMotion) start();
    }

    const observer = new ResizeObserver(resize);
    observer.observe(canvas);

    canvas.addEventListener('pointermove', movePointer);
    canvas.addEventListener('pointerdown', pointerDown);
    canvas.addEventListener('pointerup', pointerUp);
    canvas.addEventListener('pointercancel', pointerUp);
    canvas.addEventListener('pointerleave', pointerLeave);
    document.addEventListener('visibilitychange', visibilityChange);

    resize();
    if (reducedMotion) draw();
    else if (!document.hidden) start();

    return () => {
      stop();
      observer.disconnect();
      canvas.removeEventListener('pointermove', movePointer);
      canvas.removeEventListener('pointerdown', pointerDown);
      canvas.removeEventListener('pointerup', pointerUp);
      canvas.removeEventListener('pointercancel', pointerUp);
      canvas.removeEventListener('pointerleave', pointerLeave);
      document.removeEventListener('visibilitychange', visibilityChange);
    };
  }, []);

  return (
    <canvas
      ref={canvasRef}
      aria-hidden="true"
      className={className}
      style={{
        display: 'block',
        width: '100%',
        height,
        background: 'var(--fill)',
        borderRadius: 'var(--r-card)',
        touchAction: 'none',
        cursor: 'grab',
        ...style,
      }}
    />
  );
}
