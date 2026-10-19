import { useId, useRef, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useT } from '../../i18n';
import { useAppStore } from '../../store/useAppStore';
import { listEpisodes, seriesOwnerId } from '../../store/store.utils';
import ModalOverlay from './ModalOverlay';
import PopupCloseButton from './PopupCloseButton';

/** 按次挂载，避免外部名称更新覆盖正在输入的草稿。未传 episodeId 时创建分集。 */
export default function EpisodeNameDialog({
  episodeId,
  onClose,
}: {
  episodeId?: string;
  onClose: () => void;
}) {
  const t = useT();
  const inputId = useId();
  const { projects, currentProjectId, projectLoadStatus, addEpisode, renameProject, showToast } = useAppStore(
    useShallow((state) => ({
      projects: state.projects,
      currentProjectId: state.currentProjectId,
      projectLoadStatus: state.projectLoadStatus,
      addEpisode: state.addEpisode,
      renameProject: state.renameProject,
      showToast: state.showToast,
    })),
  );
  const [initial] = useState(() => {
    const current = projects.find((project) => project.id === currentProjectId);
    const seriesId = current ? seriesOwnerId(projects, current.id) : '';
    // 普通项目转为剧集时，原画布保留为第 1 集。
    const nextNo = listEpisodes(projects, seriesId).reduce(
      (max, episode) => Math.max(max, episode.episodeNo ?? 0), current?.parentId ? 0 : 1,
    ) + 1;
    return {
      projectId: currentProjectId,
      name: episodeId
        ? projects.find((project) => project.id === episodeId)?.name ?? ''
        : t('第 {number} 集', { number: nextNo }),
    };
  });
  const [name, setName] = useState(initial.name);
  const [isSaving, setIsSaving] = useState(false);
  const savingRef = useRef(false);
  const ready = projectLoadStatus === 'ready' && currentProjectId === initial.projectId
    && Boolean(currentProjectId) && (!episodeId || projects.some((project) => project.id === episodeId));
  const title = episodeId ? t('修改分集名称') : t('新增分集');
  const close = () => {
    if (!savingRef.current) onClose();
  };

  const submit = async () => {
    const nextName = name.trim();
    const latest = useAppStore.getState();
    if (!ready || !nextName || savingRef.current) return;
    if (latest.currentProjectId !== initial.projectId || latest.projectLoadStatus !== 'ready') return;
    savingRef.current = true;
    setIsSaving(true);
    try {
      const saved = episodeId
        ? await renameProject(episodeId, nextName)
        : await addEpisode(nextName === initial.name ? undefined : nextName);
      if (saved) onClose();
    } catch {
      showToast(episodeId ? t('修改分集名称失败，请重试') : t('创建分集失败，请重试'), 'error');
    } finally {
      savingRef.current = false;
      setIsSaving(false);
    }
  };

  return (
    <ModalOverlay
      isOpen
      onClose={close}
      ariaLabel={title}
      zIndex={320}
      className="w-[min(380px,calc(100vw-24px))] border-canvas-border text-canvas-text"
    >
      <form
        onSubmit={(event) => { event.preventDefault(); void submit(); }}
        onKeyDown={(event) => event.stopPropagation()}
      >
        <header className="flex items-center justify-between gap-2 border-b border-border-subtle p-3">
          <h2 className="text-sm font-semibold">{title}</h2>
          <PopupCloseButton ariaLabel={t('关闭{title}', { title })} onClick={close} disabled={isSaving} />
        </header>
        <div className="ui-field p-3">
          <label className="ui-label" htmlFor={inputId}>{t('分集名称')}</label>
          <input
            id={inputId}
            autoFocus
            autoComplete="off"
            className="ui-input"
            value={name}
            disabled={isSaving}
            onFocus={(event) => event.currentTarget.select()}
            onChange={(event) => setName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && event.nativeEvent.isComposing) event.preventDefault();
            }}
          />
        </div>
        <footer className="flex justify-end gap-2 border-t border-border-subtle p-3">
          <button type="button" className="ui-btn" onClick={close} disabled={isSaving}>{t('取消')}</button>
          <button type="submit" className="ui-btn ui-btn--primary" disabled={!ready || !name.trim() || isSaving}>
            {isSaving ? t('保存中…') : episodeId ? t('保存') : t('创建分集')}
          </button>
        </footer>
      </form>
    </ModalOverlay>
  );
}
