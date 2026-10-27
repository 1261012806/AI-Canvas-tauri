vi.mock('../../src/hooks/useComfyImageSource', () => ({ useComfyImageSource: (source?: string) => source }));
vi.mock('../../src/hooks/useComfyMediaSource', () => ({ useComfyMediaSource: (source?: string) => source }));
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import VideoEditorPreview from '../../src/components/videoEditor/VideoEditorPreview';
import type { VideoEditorClip, VideoEditorTrack } from '../../src/types/videoEditor';

function clip(overrides: Partial<VideoEditorClip>): VideoEditorClip {
  return {
    id: 'clip-main',
    kind: 'video',
    sourceUrl: 'https://example.test/main.mp4',
    fileName: 'main.mp4',
    timelineStart: 0,
    sourceIn: 0,
    sourceOut: 4,
    ...overrides,
  };
}

function renderTracks(tracks: VideoEditorTrack[], mainClip: VideoEditorClip): string {
  return renderToStaticMarkup(
    <VideoEditorPreview
      clip={mainClip}
      clipUrl={mainClip.sourceUrl ?? ''}
      playhead={1}
      timelineDuration={4}
      tracks={tracks}
      selectedClipIds={tracks.flatMap((track) => track.clips.map((entry) => entry.id))}
      canvasSize={{ width: 1280, height: 720 }}
      onPlayheadChange={vi.fn()}
      onSelectClips={vi.fn()}
      onBeginInteraction={vi.fn()}
      onEndInteraction={vi.fn()}
      onTransformChange={vi.fn()}
    />,
  );
}

function renderPreview(overlayClip: VideoEditorClip, trackPatch: Partial<VideoEditorTrack> = {}): string {
  const mainClip = clip({});
  return renderTracks([
    { id: 'main', kind: 'video', name: '主轨', clips: [mainClip] },
    { id: 'overlay', kind: 'video', name: '叠加轨', overlay: true, clips: [overlayClip], ...trackPatch },
  ], mainClip);
}

describe('VideoEditorPreview overlays', () => {
  it('exposes direct move, proportional scale, and rotation controls for the selected main clip', () => {
    const mainClip = clip({});
    const html = renderTracks([
      { id: 'main', kind: 'video', name: '主轨', clips: [mainClip] },
    ], mainClip);

    expect(html).toContain('video-editor-main-selection selected');
    expect(html).toContain('aria-label="等比缩放"');
    expect(html).toContain('aria-label="旋转"');
  });

  it('renders OpenCut-style preview controls for editable timecode, zoom, and fullscreen', () => {
    const mainClip = clip({});
    const html = renderTracks([
      { id: 'main', kind: 'video', name: '主轨', clips: [mainClip] },
    ], mainClip);

    expect(html).toContain('aria-label="编辑当前时间码"');
    expect(html).toContain('aria-label="预览缩放"');
    expect(html).toContain('<option value="fit" selected="">适应</option>');
    expect(html).toContain('aria-label="全屏预览"');
    expect(html).toContain('aria-label="查看快捷键"');
  });

  it('renders an active overlay video as a native video element', () => {
    const html = renderPreview(clip({
      id: 'clip-overlay-video',
      sourceUrl: 'https://example.test/overlay.mp4',
    }));

    expect(html).toContain('src="https://example.test/overlay.mp4"');
    expect(html).toContain('<video');
    expect(html).not.toContain('src="https://example.test/overlay.mp4" alt=""');
  });

  it('keeps an active overlay image as an image element', () => {
    const html = renderPreview(clip({
      id: 'clip-overlay-image',
      kind: 'image',
      sourceUrl: 'https://example.test/overlay.png',
      fileName: 'overlay.png',
    }));

    expect(html).toContain('<img src="https://example.test/overlay.png"');
  });

  it('renders an active text clip without requiring a media URL', () => {
    const html = renderPreview(clip({
      id: 'clip-overlay-text',
      kind: 'text',
      sourceUrl: undefined,
      fileName: '片头标题',
      textStyle: {
        content: '片头标题',
        fontFamily: 'sans-serif',
        fontSize: 72,
        color: '#ffdd88',
        fontWeight: 700,
        align: 'center',
      },
    }));

    expect(html).toContain('video-editor-overlay text selected');
    expect(html).toContain('video-editor-overlay-text');
    expect(html).toContain('片头标题');
    expect(html).not.toContain('素材无法预览');
  });

  it('mutes the main media when its track is muted and hides its picture when hidden', () => {
    const mainClip = clip({});
    const html = renderTracks([
      { id: 'main', kind: 'video', name: '主轨', muted: true, hidden: true, clips: [mainClip] },
    ], mainClip);

    expect(html).toMatch(/<video[^>]*class="video-editor-video track-hidden"[^>]*muted/);
  });

  it('uses the overlay track mute state and removes transform handles when locked', () => {
    const html = renderPreview(clip({
      id: 'clip-overlay-video',
      sourceUrl: 'https://example.test/overlay.mp4',
    }), { muted: true, locked: true });

    expect(html).toMatch(/<video[^>]*src="https:\/\/example\.test\/overlay\.mp4"[^>]*muted/);
    expect(html).toContain('video-editor-overlay selected locked');
    expect(html.match(/video-editor-overlay-handle/g)).toHaveLength(4);
    expect(html.match(/video-editor-rotation-handle/g)).toHaveLength(1);
  });

  it('renders active audio-track clips as synchronized audio elements', () => {
    const mainClip = clip({});
    const audioClip = clip({
      id: 'clip-audio',
      sourceUrl: 'https://example.test/audio.mp4',
    });
    const html = renderTracks([
      { id: 'main', kind: 'video', name: '主轨', clips: [mainClip] },
      { id: 'audio', kind: 'audio', name: '音频轨', clips: [audioClip] },
    ], mainClip);

    expect(html).toContain('<audio src="https://example.test/audio.mp4"');
  });
});

describe('VideoEditorPreview transitions', () => {
  /** 两段首尾相接的主轨，后一段带 1s 转场；playhead 落在转场正中间 */
  function renderAtTransition(kind: 'dissolve' | 'fade', playhead = 4.5): string {
    const outgoing = clip({ id: 'a', sourceUrl: 'https://example.test/a.mp4', sourceOut: 4 });
    const incoming = clip({
      id: 'b',
      sourceUrl: 'https://example.test/b.mp4',
      timelineStart: 4,
      sourceOut: 4,
      transitionIn: { kind, duration: 1 },
    });
    return renderToStaticMarkup(
      <VideoEditorPreview
        clip={incoming}
        clipUrl={incoming.sourceUrl ?? ''}
        playhead={playhead}
        timelineDuration={8}
        tracks={[{ id: 'main', kind: 'video', name: '主轨', clips: [outgoing, incoming] }]}
        selectedClipIds={[]}
        canvasSize={{ width: 1280, height: 720 }}
        onPlayheadChange={vi.fn()}
        onSelectClips={vi.fn()}
        onBeginInteraction={vi.fn()}
        onEndInteraction={vi.fn()}
        onTransformChange={vi.fn()}
      />,
    );
  }

  it('fades the incoming clip so the transition is visible while editing', () => {
    // 转场过半 → 不透明度约 0.5，而不是恒定的 1
    expect(renderAtTransition('fade')).toContain('opacity:0.5');
  });

  it('lays the outgoing clip underneath for a cross dissolve', () => {
    const html = renderAtTransition('dissolve');
    expect(html).toContain('video-editor-video underlay');
    expect(html).toContain('https://example.test/a.mp4');
  });

  it('keeps a black-fade transition free of an underlay', () => {
    const html = renderAtTransition('fade');
    expect(html).not.toContain('underlay');
    expect(html).not.toContain('https://example.test/a.mp4');
  });

  it('drops the underlay once the transition window has passed', () => {
    // 5.5s 已越过 1s 转场窗口
    const html = renderAtTransition('dissolve', 5.5);
    expect(html).not.toContain('underlay');
    expect(html).toContain('opacity:1');
  });
});
