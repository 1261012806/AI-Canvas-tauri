import { useEffect, useRef, useState } from 'react';
import { ChevronDown, Cloud, Save } from 'lucide-react';
import { useT } from '../../i18n';
import { useAppStore } from '../../store/useAppStore';
import type { SharedProjectBinding, SharedStorageConnectionInput, SharedStorageCredentialUpdate } from '../../types/assetSync';
import { isTauriEnv } from '../../services/fs/core';
import { confirmAction } from '../../services/confirmDialog';
import Select from '../shared/Select';

function connectionDraft(connection?: SharedStorageConnectionInput): SharedStorageConnectionInput {
  return {
    id: connection?.id ?? '', name: connection?.name ?? '', endpoint: connection?.endpoint ?? '',
    region: connection?.region ?? '', bucket: connection?.bucket ?? '', rootPrefix: connection?.rootPrefix ?? '',
    pathStyle: connection?.pathStyle ?? true,
  };
}

/** 普通连接参数由原生目录保存；密码输入只用于这次写入，不读取已保存的凭据。 */
export default function SharedAssetStorageSettings() {
  const t = useT();
  const snapshot = useAppStore((state) => state.sharedAssetStorage);
  const loading = useAppStore((state) => state.sharedAssetStorageLoading);
  const projects = useAppStore((state) => state.projects);
  const projectsReady = useAppStore((state) => state.projectInitialized && state.projectLoadStatus === 'ready');
  const [selectedId, setSelectedId] = useState('');
  const [draft, setDraft] = useState(connectionDraft);
  const [expectedRevision, setExpectedRevision] = useState<string>();
  const [clearCredentials, setClearCredentials] = useState(false);
  const [clearSessionToken, setClearSessionToken] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const accessKeyRef = useRef<HTMLInputElement>(null);
  const secretKeyRef = useRef<HTMLInputElement>(null);
  const tokenRef = useRef<HTMLInputElement>(null);
  const mounted = useRef(false);
  const operation = useRef(0);
  const locked = useRef(false);
  const desktop = isTauriEnv();
  const saved = snapshot?.connections.find((connection) => connection.id === selectedId);
  const orphanedBindings = projectsReady ? (snapshot?.bindings ?? []).filter((binding) => binding.connectionId === selectedId
    && !projects.some((project) => project.id === binding.ownerId)) : [];
  let targetChanged = false;
  if (saved) {
    try { targetChanged = new URL(draft.endpoint.trim()).origin !== saved.endpoint; }
    catch { targetChanged = true; }
    targetChanged ||= draft.region.trim() !== saved.region || draft.bucket.trim() !== saved.bucket
      || draft.rootPrefix.trim().replace(/^\/+|\/+$/g, '') !== saved.rootPrefix || draft.pathStyle !== saved.pathStyle;
  }

  const clearSecretInputs = () => {
    for (const ref of [accessKeyRef, secretKeyRef, tokenRef]) if (ref.current) ref.current.value = '';
  };

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      operation.current += 1;
      for (const ref of [accessKeyRef, secretKeyRef, tokenRef]) if (ref.current) ref.current.value = '';
    };
  }, []);
  useEffect(() => {
    let active = true;
    if (desktop) void useAppStore.getState().loadSharedAssetStorage().catch((cause: unknown) => {
      if (active && mounted.current) setError(t(cause instanceof Error ? cause.message : '项目云同步配置读取失败'));
    });
    return () => { active = false; };
  }, [desktop, t]);

  const selectConnection = (id: string) => {
    if (locked.current) return;
    const connection = snapshot?.connections.find((entry) => entry.id === id);
    clearSecretInputs();
    setSelectedId(connection?.id ?? '');
    setDraft(connectionDraft(connection));
    setExpectedRevision(connection?.revision);
    setClearCredentials(false); setClearSessionToken(false);
    setError(''); setNotice('');
  };

  const save = async () => {
    if (locked.current || !desktop) return;
    setError(''); setNotice('');
    let endpoint: URL;
    try { endpoint = new URL(draft.endpoint.trim()); } catch { setError(t('请输入有效的 HTTPS S3 Endpoint')); return; }
    if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || endpoint.pathname !== '/' || endpoint.search || endpoint.hash) {
      setError(t('S3 Endpoint 必须为不含路径、凭据、查询参数或片段的 HTTPS 服务地址')); return;
    }
    if (!draft.pathStyle && (/^\d+\.\d+\.\d+\.\d+$/.test(endpoint.hostname) || endpoint.hostname.startsWith('['))) {
      setError(t('IP Endpoint 仅支持 Path-style。')); return;
    }
    if (!draft.name.trim() || !draft.region.trim() || !draft.bucket.trim()) {
      setError(t('请填写连接名称、Region 和 Bucket')); return;
    }
    if (Array.from(draft.name.trim()).length > 160) {
      setError(t('连接名称不能超过 160 个字符')); return;
    }
    const accessKeyId = accessKeyRef.current?.value.trim() ?? '';
    const secretAccessKey = secretKeyRef.current?.value.trim() ?? '';
    const sessionToken = tokenRef.current?.value.trim() ?? '';
    if (!!accessKeyId !== !!secretAccessKey) { setError(t('AK 与 SK 需要一起填写')); return; }
    const credentials: SharedStorageCredentialUpdate = clearCredentials ? { clearCredentials: true } : {
      ...(accessKeyId && secretAccessKey ? { accessKeyId, secretAccessKey } : {}),
      ...(clearSessionToken ? { clearSessionToken: true } : sessionToken ? { sessionToken } : {}),
    };
    const connection = { ...draft, id: draft.id || crypto.randomUUID(), name: draft.name.trim(),
      endpoint: draft.endpoint.trim(), region: draft.region.trim(), bucket: draft.bucket.trim(), rootPrefix: draft.rootPrefix.trim() };
    const run = ++operation.current;
    locked.current = true; setBusy(true);
    try {
      await useAppStore.getState().saveSharedStorageConnection({ connection, expectedRevision,
        credentials: Object.keys(credentials).length ? credentials : undefined });
      if (!mounted.current || run !== operation.current) return;
      const latest = useAppStore.getState().sharedAssetStorage?.connections.find((entry) => entry.id === connection.id);
      if (latest) {
        setSelectedId(latest.id); setDraft(connectionDraft(latest)); setExpectedRevision(latest.revision);
      }
      setClearCredentials(false); setClearSessionToken(false);
      setNotice(t('S3 连接已保存；请在当前项目中绑定并立即同步。'));
    } catch (cause) {
      if (mounted.current && run === operation.current) setError(t(cause instanceof Error ? cause.message : 'S3 连接保存失败'));
    } finally {
      clearSecretInputs();
      locked.current = false;
      if (mounted.current && run === operation.current) setBusy(false);
    }
  };

  const remove = async () => {
    if (!saved || locked.current) return;
    const target = saved;
    locked.current = true; setBusy(true); setError(''); setNotice('');
    const run = ++operation.current;
    try {
      const confirmed = await confirmAction(t('删除此 S3 连接及其本机凭据？不会删除云端或本地资产。'), {
        title: t('删除 S3 连接'), kind: 'warning', okLabel: t('删除连接'),
      });
      if (!confirmed || !mounted.current || run !== operation.current) return;
      await useAppStore.getState().removeSharedStorageConnection(target.id, target.revision);
      if (!mounted.current || run !== operation.current) return;
      clearSecretInputs(); setSelectedId(''); setDraft(connectionDraft()); setExpectedRevision(undefined);
      setClearCredentials(false); setClearSessionToken(false); setNotice(t('S3 连接已删除；本地和云端资产保留。'));
    } catch (cause) {
      if (mounted.current && run === operation.current) setError(t(cause instanceof Error ? cause.message : 'S3 连接删除失败'));
    } finally {
      locked.current = false;
      if (mounted.current && run === operation.current) setBusy(false);
    }
  };

  const removeOrphanedBinding = async (target: SharedProjectBinding) => {
    if (locked.current) return;
    locked.current = true; setBusy(true); setError(''); setNotice('');
    const run = ++operation.current;
    try {
      const confirmed = await confirmAction(t('清理已删除项目「{name}」的本机共享绑定？不会删除本地或云端资产。', { name: target.ownerName || target.ownerId }), {
        title: t('清理本机绑定'), kind: 'warning', okLabel: t('清理本机绑定'),
      });
      if (!confirmed || !mounted.current || run !== operation.current) return;
      const state = useAppStore.getState();
      const live = state.sharedAssetStorage?.bindings.find((binding) => binding.ownerId === target.ownerId);
      if (!state.projectInitialized || state.projectLoadStatus !== 'ready'
        || state.projects.some((project) => project.id === target.ownerId) || !live
        || live.connectionId !== target.connectionId || live.connectionRevision !== target.connectionRevision
        || live.libraryId !== target.libraryId || live.sharedProjectId !== target.sharedProjectId) {
        throw new Error(t('连接或项目绑定已改变，请刷新后重试'));
      }
      await state.unbindSharedProject(target.ownerId, target.connectionRevision);
      if (mounted.current && run === operation.current) setNotice(t('已清理失效项目的本机绑定，云端和本地资产保留。'));
    } catch (cause) {
      if (mounted.current && run === operation.current) setError(t(cause instanceof Error ? cause.message : '项目云存储操作失败'));
    } finally {
      locked.current = false;
      if (mounted.current && run === operation.current) setBusy(false);
    }
  };

  const update = (patch: Partial<SharedStorageConnectionInput>) => {
    // 尚未保存的新输入也不能随目标改动被带到另一地址或 Bucket。
    if (patch.endpoint !== undefined || patch.region !== undefined || patch.bucket !== undefined
      || patch.rootPrefix !== undefined || patch.pathStyle !== undefined) clearSecretInputs();
    setDraft((current) => ({ ...current, ...patch })); setNotice('');
  };
  return <details className="ui-card group mt-3" aria-busy={busy || loading}>
    <summary className="ui-card__header cursor-pointer list-none gap-3 select-none hover:bg-canvas-hover focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-canvas-text-muted [&::-webkit-details-marker]:hidden">
      <Cloud size={18} className="shrink-0 text-canvas-text-secondary" aria-hidden="true" />
      <div className="min-w-0 flex-1"><h3 className="ui-card__title">{t('项目云同步 · S3 连接')}</h3>
        <p className="ui-card__desc">{t('此页管理 S3 连接；资产传输从项目中的立即同步发起。')}</p></div>
      {busy || loading ? <span className="ui-spinner shrink-0" aria-hidden="true" /> : null}
      <span className="ui-badge ui-badge--outline hidden shrink-0 sm:inline-flex">{t('连接设置')}</span>
      <ChevronDown size={16} className="shrink-0 text-canvas-text-muted group-open:rotate-180" aria-hidden="true" />
    </summary>
    <div className="ui-card__body space-y-3">
      {!desktop && <p className="ui-alert ui-alert--info">{t('项目云同步仅支持 Tauri 桌面应用')}</p>}
      <label className="ui-field"><span className="ui-label">{t('S3 连接')}</span>
        <Select value={selectedId} onChange={selectConnection} disabled={!desktop || busy || loading} className="w-full"
          aria-label={t('S3 连接')} options={[{ value: '', label: t('新建 S3 连接') },
            ...(snapshot?.connections ?? []).map((connection) => ({ value: connection.id, label: connection.name }))]} />
      </label>
      {!!orphanedBindings.length && <section className="ui-alert ui-alert--warning flex-col items-stretch gap-2" aria-label={t('已删除项目的本机绑定')}>
        <h4 className="text-xs font-medium">{t('已删除项目的本机绑定')}</h4>
        <p className="ui-hint">{t('清理这些本机绑定后才能删除连接；不会删除任何资产。')}</p>
        {orphanedBindings.map((binding) => <div key={binding.ownerId} className="flex min-w-0 flex-wrap items-center gap-2">
          <span className="min-w-0 flex-1 break-words text-xs">{binding.ownerName || binding.ownerId}</span>
          <button type="button" className="ui-btn ui-btn--ghost ui-btn--sm" disabled={busy || loading || !desktop} onClick={() => void removeOrphanedBinding(binding)}>{t('清理本机绑定')}</button>
        </div>)}
      </section>}
      <form className="space-y-3" onSubmit={(event) => { event.preventDefault(); void save(); }}>
        <fieldset disabled={!desktop || busy || loading} className="min-w-0 space-y-3">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <label className="ui-field"><span className="ui-label">{t('连接名称')}</span><input className="ui-input" required maxLength={160} value={draft.name} onChange={(event) => update({ name: event.target.value })} /></label>
            <label className="ui-field"><span className="ui-label">Endpoint</span><input className="ui-input" type="url" required maxLength={2048} autoComplete="off" placeholder="https://s3.example.com" value={draft.endpoint} onChange={(event) => update({ endpoint: event.target.value })} /></label>
            <label className="ui-field"><span className="ui-label">Region</span><input className="ui-input" required maxLength={64} value={draft.region} onChange={(event) => update({ region: event.target.value })} /></label>
            <label className="ui-field"><span className="ui-label">Bucket</span><input className="ui-input" required maxLength={63} value={draft.bucket} onChange={(event) => update({ bucket: event.target.value })} /></label>
            <label className="ui-field"><span className="ui-label">{t('根前缀')}</span><input className="ui-input" maxLength={256} value={draft.rootPrefix} onChange={(event) => update({ rootPrefix: event.target.value })} /></label>
            <label className="ui-field"><span className="ui-label">{t('寻址方式')}</span>
              <Select value={draft.pathStyle ? 'path' : 'virtual'} onChange={(value) => update({ pathStyle: value === 'path' })}
                disabled={busy || loading || !desktop} aria-label={t('寻址方式')} className="w-full"
                options={[{ value: 'path', label: 'Path-style' }, { value: 'virtual', label: 'Virtual-hosted' }]} />
              <span className="ui-hint">{t('IP Endpoint 仅支持 Path-style。')}</span>
            </label>
          </div>
          <p className="ui-hint">{t('填写 S3 服务根地址，不包含 Bucket 名称、路径或查询参数。虚拟主机模式会自动添加 Bucket 子域名。')}</p>
          {targetChanged && <p className="ui-alert ui-alert--warning">{t('更换 Endpoint、Region、Bucket、根前缀或寻址方式会清除旧凭据，请为新目标重新填写 AK/SK。')}</p>}
          <div className="flex flex-wrap items-center gap-2 border-t border-canvas-border pt-3">
            <span className={`ui-badge ${saved?.credentialsSaved && !targetChanged ? 'ui-badge--success' : 'ui-badge--outline'}`}>{t(saved?.credentialsSaved && !targetChanged ? '凭据已保存' : '尚未保存凭据')}</span>
            {saved?.sessionTokenSaved && !targetChanged && <span className="ui-badge ui-badge--info">{t('已保存 SessionToken')}</span>}
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <label className="ui-field"><span className="ui-label">Access Key ID (AK)</span><input ref={accessKeyRef} className="ui-input" type="password" maxLength={1024} autoComplete="new-password" disabled={clearCredentials} placeholder={t(saved?.credentialsSaved && !targetChanged ? '留空保留已保存的凭据' : '输入新的 AK')} /></label>
            <label className="ui-field"><span className="ui-label">Secret Access Key (SK)</span><input ref={secretKeyRef} className="ui-input" type="password" maxLength={2048} autoComplete="new-password" disabled={clearCredentials} placeholder={t(saved?.credentialsSaved && !targetChanged ? '留空保留已保存的凭据' : '输入新的 SK')} /></label>
          </div>
          <label className="ui-field"><span className="ui-label">SessionToken{t('（可选）')}</span><input ref={tokenRef} className="ui-input" type="password" maxLength={4096} autoComplete="new-password" disabled={clearCredentials || clearSessionToken} placeholder={t(saved?.sessionTokenSaved && !targetChanged ? '留空保留已保存的会话令牌' : '没有临时凭据时留空')} /></label>
          {saved?.credentialsSaved && <label className="flex items-center gap-2 text-xs text-canvas-text-secondary"><input type="checkbox" checked={clearCredentials} onChange={(event) => { clearSecretInputs(); setClearCredentials(event.target.checked); }} />{t('明确清除已保存的 AK/SK 和会话令牌')}</label>}
          {saved?.sessionTokenSaved && !clearCredentials && <label className="flex items-center gap-2 text-xs text-canvas-text-secondary"><input type="checkbox" checked={clearSessionToken} onChange={(event) => { if (tokenRef.current) tokenRef.current.value = ''; setClearSessionToken(event.target.checked); }} />{t('明确清除已保存的 SessionToken')}</label>}
          <p className="ui-hint">{t('凭据仅提交到本机原生凭据存储；不读取旧密钥，也不写入项目或普通配置。')}</p>
          <div className="flex flex-wrap items-center gap-2 border-t border-canvas-border pt-3">
            <button type="submit" className="ui-btn ui-btn--primary ui-btn--sm"><Save size={14} aria-hidden="true" />{busy ? t('正在保存…') : t('保存 S3 连接')}</button>
            {saved && <button type="button" className="ui-btn ui-btn--ghost ui-btn--sm" onClick={() => void remove()}>{t('删除连接')}</button>}
          </div>
        </fieldset>
      </form>
      {error && <p role="alert" className="ui-alert ui-alert--danger">{error}</p>}
      {notice && <p role="status" className="ui-alert ui-alert--info">{notice}</p>}
    </div>
  </details>;
}
