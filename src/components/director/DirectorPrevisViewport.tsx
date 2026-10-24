import { useEffect, useRef, useState } from 'react';
import type { DirectorPrevisScene, DirectorPrevisView } from '../../types/directorPrevis';
import { createDirectorPrevisRenderer, type DirectorPrevisRenderer } from '../../services/directorPrevisRenderer';
import { useT } from '../../i18n';

export default function DirectorPrevisViewport({ scene, time, view, theme, onReady }: {
  scene: DirectorPrevisScene; time: number; view: DirectorPrevisView; theme: string;
  onReady: (renderer: DirectorPrevisRenderer | null) => void;
}) {
  const t = useT();
  const mount = useRef<HTMLDivElement>(null);
  const renderer = useRef<DirectorPrevisRenderer | null>(null);
  const latest = useRef({ time, view, onReady });
  const [error, setError] = useState('');
  useEffect(() => { latest.current = { time, view, onReady }; }, [time, view, onReady]);
  useEffect(() => {
    const element = mount.current;
    if (!element) return;
    let instance: DirectorPrevisRenderer | undefined;
    let active = true;
    try {
      instance = createDirectorPrevisRenderer(element, scene);
      renderer.current = instance;
      instance.render(latest.current.time, latest.current.view);
      latest.current.onReady(instance);
      queueMicrotask(() => { if (active) setError(''); });
    } catch {
      instance?.dispose();
      renderer.current = null;
      latest.current.onReady(null);
      queueMicrotask(() => { if (active) setError('无法创建三维预览，请检查 WebGL 或显卡支持'); });
    }
    return () => { active = false; latest.current.onReady(null); renderer.current = null; instance?.dispose(); };
  }, [scene, theme]);
  useEffect(() => { renderer.current?.render(time, view); }, [time, view]);
  return (
    <div className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden rounded-lg border border-canvas-border bg-canvas-bg">
      <div ref={mount} className="flex h-full w-full items-center justify-center overflow-hidden" />
      {error && <p className="ui-error absolute p-3" role="alert">{t(error)}</p>}
    </div>
  );
}
