import { useCallback, useEffect, useRef, useState } from 'react';
import { t } from '../i18n';
import { confirmAction } from '../services/confirmDialog';
import { isTauriEnv } from '../services/fileService';
import { inspectSpeechModels, LocalSpeechModelError } from '../services/onnxService';
import type { PluginManifest } from '../types/plugin';
import { useModelDownload } from './useModelDownload';

export function pluginUsesSpeechModels(manifest: PluginManifest): boolean {
  return manifest.requiredCapabilities?.includes('video.replicaPipeline') === true;
}

/** 仅在用户安装或补齐依赖时下载；后台初始化只检查现有缓存。 */
export function usePluginSpeechModels(inspectInstalled: boolean) {
  const [ready, setReady] = useState<boolean | null>(null);
  const [isPreparing, setIsPreparing] = useState(false);
  const mounted = useRef(true);
  const pending = useRef(false);
  const inspection = useRef(0);
  const modelDownload = useModelDownload();
  const { download, cancel } = modelDownload;

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  const inspect = useCallback(async () => {
    const request = ++inspection.current;
    const status = await inspectSpeechModels();
    if (mounted.current && request === inspection.current) setReady(status.ready);
    return status;
  }, []);

  useEffect(() => {
    if (!inspectInstalled || !isTauriEnv()) return;
    // 失败时保留“准备语音模型”入口；不在打开设置页时弹下载或启动网络请求。
    void inspect().catch(() => {});
  }, [inspect, inspectInstalled]);

  const prepare = useCallback(async (manifest: PluginManifest, allowSkip = true): Promise<boolean> => {
    if (!mounted.current) return false;
    if (!pluginUsesSpeechModels(manifest)) return true;
    if (pending.current) return false;
    pending.current = true;
    setIsPreparing(true);
    try {
      if (!isTauriEnv()) throw new LocalSpeechModelError(t('请在 Tauri 桌面版中准备语音模型'));
      const status = await inspect();
      if (!mounted.current) return false;
      if (status.ready) return true;
      const confirmed = await confirmAction(
        t('插件「{name}」的对白转写需要本地 SenseVoice 语音模型（约 230 MB）和词表。已存在的文件会复用；下载后可离线使用，不需要 API Key。', { name: manifest.name })
        + (allowSkip ? `\n\n${t('也可以仅安装插件，使用对白转写前再下载模型。')}` : ''),
        {
          title: t('语音识别模型未安装'),
          okLabel: t(allowSkip ? '下载并继续安装' : '下载模型'),
          cancelLabel: t(allowSkip ? '仅安装插件' : '取消'),
        },
      );
      if (!mounted.current) return false;
      if (!confirmed) return allowSkip;
      if (!(await download(status.missing)) || !mounted.current) return false;
      const completed = await inspect();
      if (!mounted.current) return false;
      if (!completed.ready) throw new LocalSpeechModelError(t('语音模型下载后未通过完整性检查，请重新下载'));
      return true;
    } finally {
      pending.current = false;
      if (mounted.current) setIsPreparing(false);
    }
  }, [download, inspect]);

  return { ...modelDownload, ready, isPreparing, prepare, cancel };
}
