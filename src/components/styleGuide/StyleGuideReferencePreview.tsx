import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type MouseEvent } from 'react';
import type { ReferencePreviewContent } from '../../types/referencePreview';
import ReferenceContentPreview from '../shared/ReferenceContentPreview';
import FileUploadButton from '../shared/FileUploadButton';
import { buildReferenceChipEl } from '../shared/referenceChipDom';
import { getNodeChipIconPath } from '../nodes/shared/mentionEditorDom';
import referenceImage from '../../assets/images/styles/realistic.webp';
import sceneImage from '../../assets/images/styles/cinematic.webp';

const SHOT_TEXT = `第12镜 · 厨房门口\n景别：双人中景\n运镜：固定机位\n时长：8秒\n\n画面：小绘靠着门框，手里的杯子还冒着热气。创作者听见声音，先停下敲键盘的手，才回头。两个人都没有立刻接话。\n\n对白：\n创作者：“还没睡？”\n小绘：“你不也没睡。”\n创作者看了一眼杯子：“给我的？”\n小绘把杯子搁到桌角：“烫。等会儿再喝。”\n\n声音：杯底轻碰桌面的声音，远处的冰箱压缩机短促启动；没有额外旁白或配乐。\n\n备注：保持角色服装、左右站位和桌面摆设连续。镜头结束时，杯子仍在桌角。这里显示单镜的完整内容，不能使用悬浮提示中截断的文字。`;
const CONTENTS: Record<string, ReferencePreviewContent> = {
  text: { kind: 'text', title: '完整文本', text: '引用内容保持原始换行。\n\n双击胶囊后，全文在只读查看器中展示；预览不会改动提示词或创建节点。\n\n这只是本窗口里的示例，不读取当前项目。' },
  shot: { kind: 'text', title: '镜12 · 分镜表', text: SHOT_TEXT, description: '单镜全文示例 · 内容、对白与声音保持在同一个上下文中。',
    details: [{ label: '来源', value: 'UI Kit 示例分镜表' }, { label: '镜头编号', value: '12' }, { label: '景别', value: '双人中景' }, { label: '运镜', value: '固定机位' }, { label: '镜头时长', value: '8 秒' }] },
  image: { kind: 'image', title: '角色参考图', mediaUrl: referenceImage, description: '复用资源库的图片缩放与平移查看器。',
    details: [{ label: '来源', value: 'UI Kit 示例素材' }, { label: '资产类型', value: '人物' }, { label: '参考图用途', value: '主视觉' }] },
  images: { kind: 'image', title: '多张参考图', images: [{ url: referenceImage, label: '角色参考' }, { url: sceneImage, label: '场景参考' }], description: '选择右侧缩略图切换，保持各张图片的完整画面。' },
  crop: { kind: 'image', title: '宫格裁片', mediaUrl: sceneImage, imageCrop: { x: 20, y: 10, width: 50, height: 60 }, description: '按源图百分比区域显示裁片，预览不修改原始图片。' },
  markdown: { kind: 'markdown', title: 'Markdown 文档', text: '# 镜头备忘\n\n完整保留 **对白**、段落和表格。\n\n| 镜头 | 状态 |\n| --- | --- |\n| 12 | 等待生成 |\n\n> 先停下手里的动作，再回头看对方。\n\n- [x] 角色参考已确定\n- [ ] 检查镜头连续性\n\n```text\n小绘：烫。等会儿再喝。\n```' },
  missing: { kind: 'text', title: '已失效的引用', unavailable: '引用内容已不存在。请重新选择素材或恢复原始节点。' },
};
const SAMPLES = [
  { id: 'text', label: '完整文本', kind: 'text' as const, icon: 'ai-text' },
  { id: 'shot', label: '镜12 · 单镜长文', kind: 'text' as const, icon: 'ai-shotlist' },
  { id: 'image', label: '角色参考', kind: 'image' as const, thumbnailUrl: referenceImage },
  { id: 'images', label: '全部参考图', kind: 'image' as const, thumbnailUrl: sceneImage },
  { id: 'crop', label: '宫格裁片', kind: 'image' as const, thumbnailUrl: sceneImage },
  { id: 'markdown', label: 'Markdown', kind: 'markdown' as const, icon: 'ai-markdown' },
  { id: 'video', label: '本地视频', kind: 'video' as const, icon: 'ai-video' },
  { id: 'audio', label: '本地音频', kind: 'audio' as const, icon: 'ai-audio' },
  { id: 'missing', label: '失效引用', kind: 'text' as const, icon: 'ai-text' },
];

/** 演示复用真实胶囊与全屏组件；所有示例和本地文件仅在此窗口保留。 */
export default function StyleGuideReferencePreview() {
  const rootRef = useRef<HTMLDivElement>(null);
  const objectUrlRef = useRef<string | null>(null);
  const [files, setFiles] = useState<{ video: File | null; audio: File | null }>({ video: null, audio: null });
  const [error, setError] = useState('');
  const [preview, setPreview] = useState<ReferencePreviewContent | null>(null);
  const releaseObjectUrl = useCallback(() => {
    if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);
    objectUrlRef.current = null;
  }, []);
  useEffect(() => releaseObjectUrl, [releaseObjectUrl]);
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    root.replaceChildren(...SAMPLES.map((sample) => {
      const label = sample.id === 'video' || sample.id === 'audio' ? files[sample.id]?.name || sample.label : sample.label;
      const chip = buildReferenceChipEl(root.ownerDocument, {
        label, kind: sample.kind, thumbnailUrl: sample.thumbnailUrl,
        iconPath: sample.icon ? getNodeChipIconPath(sample.icon) : undefined,
      });
      chip.dataset.previewSample = sample.id;
      chip.tabIndex = 0;
      chip.setAttribute('role', 'button');
      chip.setAttribute('aria-label', `${label}，双击全屏查看，也可按 Enter`);
      chip.title = `${label} · 双击全屏查看`;
      return chip;
    }));
    return () => root.replaceChildren();
  }, [files]);
  const openSample = (id: string) => {
    releaseObjectUrl();
    if (id === 'video' || id === 'audio') {
      const file = files[id];
      const url = file ? URL.createObjectURL(file) : undefined;
      objectUrlRef.current = url || null;
      setPreview({ kind: id, title: file?.name || (id === 'video' ? '本地视频' : '本地音频'), mediaUrl: url,
        unavailable: file ? undefined : `请先选择本地${id === 'video' ? '视频' : '音频'}文件，再双击此胶囊。`,
        description: '只在当前样式预览窗口中播放，关闭预览时释放播放资源。' });
    } else if (CONTENTS[id]) setPreview(CONTENTS[id]);
  };
  const openFromEvent = (event: MouseEvent<HTMLDivElement> | KeyboardEvent<HTMLDivElement>) => {
    const target = event.target instanceof Element ? event.target.closest<HTMLElement>('[data-preview-sample]') : null;
    if (!target || !rootRef.current?.contains(target)) return;
    event.preventDefault(); event.stopPropagation();
    openSample(target.dataset.previewSample!);
  };
  const closePreview = () => { setPreview(null); releaseObjectUrl(); };
  return <div className="ui-stack">
    <p className="ui-hint">双击任意胶囊查看完整内容；键盘聚焦后按 Enter。下列示例不会写入项目。</p>
    <div ref={rootRef} className="ui-row" onDoubleClick={openFromEvent}
      onKeyDown={(event) => { if (event.key === 'Enter' && !event.repeat) openFromEvent(event); }} />
    <div className="ui-row">
      {(['video', 'audio'] as const).map((kind) => <FileUploadButton key={kind} label={kind === 'video' ? '选择视频' : '选择音频'}
        accept={`${kind}/*`} aria-label={`选择${kind === 'video' ? '视频' : '音频'}预览样例`} fileName={files[kind]?.name || ''}
        className="min-w-0 flex-1" onChange={(event) => {
          const file = event.currentTarget.files?.[0];
          if (!file) return;
          if (file.type && !file.type.startsWith(`${kind}/`)) { setError(`请选择${kind === 'video' ? '视频' : '音频'}文件`); return; }
          setError(''); setFiles((current) => ({ ...current, [kind]: file }));
        }} />)}
    </div>
    {error && <p role="status" className="ui-hint">{error}</p>}
    {preview && <ReferenceContentPreview content={preview} onClose={closePreview} />}
  </div>;
}
