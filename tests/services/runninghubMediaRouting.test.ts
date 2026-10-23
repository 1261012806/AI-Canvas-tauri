import type { Node } from '@xyflow/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BaseNodeData } from '../../src/types';
import type { AudioProviderRequest, ImageProviderRequest } from '../../src/services/ai/mediaProviderRegistry';
import type { VideoGenerationReferenceInput } from '../../src/types/aiTypes';
import { useAppStore } from '../../src/store/useAppStore';
import { generateImage } from '../../src/services/ai/generateImage';
import { generateVideo } from '../../src/services/ai/generateVideo';
import { generateAudio } from '../../src/services/ai/generateAudio';
import { mediaProviderRegistry } from '../../src/services/ai/mediaProviderRegistry';
import * as imageUtils from '../../src/services/ai/imageUtils';

const mocks = vi.hoisted(() => ({ workflow: vi.fn(), assetUrl: vi.fn() }));
vi.mock('../../src/services/ai/providers/runninghubWorkflow', async (original) => ({
  ...await original<typeof import('../../src/services/ai/providers/runninghubWorkflow')>(),
  executeRunningHubWorkflow: mocks.workflow,
}));
vi.mock('../../src/services/fileService', async (original) => ({
  ...await original<typeof import('../../src/services/fileService')>(),
  getAssetUrlFromPath: mocks.assetUrl,
}));

const media = {
  first: 'data:image/png;base64,YQ==', second: 'data:image/png;base64,Yg==',
  video: 'data:video/mp4;base64,dg==', audio: 'data:audio/wav;base64,YQ==',
  lastFrame: 'data:image/png;base64,bGFzdA==', firstFrame: 'data:image/png;base64,Zmlyc3Q=',
};
const oldImageUrl = 'https://expired.example/first.png';
function configure(kind: 'image' | 'video' | 'audio') {
  const nodes: Node<BaseNodeData>[] = [
    { id: 'first', type: 'source-image', position: { x: 0, y: 0 },
      data: { type: 'source-image', label: '一', imageUrl: oldImageUrl, filePath: 'fixtures/first.png' } },
    { id: 'second', type: 'source-image', position: { x: 0, y: 0 },
      data: { type: 'source-image', label: '二', imageUrl: media.second } },
    { id: 'video', type: 'ai-video', position: { x: 0, y: 0 }, data: { type: 'ai-video', label: '视频', videoUrl: media.video } },
    { id: 'audio', type: 'ai-audio', position: { x: 0, y: 0 }, data: { type: 'ai-audio', label: '声音', audioUrl: media.audio } },
    { id: 'text', type: 'ai-text', position: { x: 0, y: 0 }, data: { type: 'ai-text', label: '正文', output: '当前节点正文' } },
    { id: 'unrelated', type: 'source-image', position: { x: 0, y: 0 },
      data: { type: 'source-image', label: '无关素材', imageUrl: 'data:image/png;base64,bm8=' } },
  ];
  useAppStore.setState({ nodes, edges: [{ id: 'same-image', source: 'first', target: 'target' }], workflows: [{
    id: 'rh-workflow', name: 'RH 工作流', category: `ai-${kind}`, fileName: 'RH', fileContent: '', createdAt: 1,
    adapterType: 'runninghub', runninghub: { version: 1, kind: 'workflow', remoteId: '123', connectionId: 'runninghub', parameters: [] },
  }] });
}

beforeEach(() => {
  useAppStore.setState(useAppStore.getInitialState(), true);
  mocks.workflow.mockReset().mockResolvedValue([{ kind: 'image', url: 'https://cdn.example/result' }]);
  mocks.assetUrl.mockReset().mockResolvedValue(media.first);
});
afterEach(() => vi.restoreAllMocks());

describe('RunningHub 本轮节点提示词与媒体入口', () => {
  it('图片云工作流使用三类本地引用，合并旧图片地址后编号与最终数组一致', async () => {
    configure('image');
    await generateImage({ provider: 'runninghubwf', model: 'runninghubwf/rh-workflow', workflowId: 'rh-workflow', nodeId: 'target',
      prompt: '@{text:正文} @{second:二} @{video:视频} @{first:一} @{audio:声音}', image_urls: [media.first] });
    const request = mocks.workflow.mock.calls[0][0];
    expect(request.references).toEqual({ image: [media.first, media.second], video: [media.video], audio: [media.audio] });
    expect(request.prompt).toContain('当前节点正文 图片2 视频1 图片1 音频1');
    expect(request.prompt).not.toContain(oldImageUrl);
    expect(request.prompt).not.toContain('data:');
    expect(request.prompt).not.toContain('@{');
  });

  it('RH 标准图片模型沿用同一本地媒体通道，不重复加入图片来源 URL', async () => {
    configure('image');
    let captured: ImageProviderRequest | undefined;
    const generate = vi.fn(async (request: ImageProviderRequest) => {
      captured = request;
      return { requestedCount: 1, failedCount: 0, results: [{ url: 'https://cdn.example/output.png', width: 1024, height: 1024 }] };
    });
    vi.spyOn(mediaProviderRegistry, 'getImageAdapter').mockReturnValue({ providerId: 'runninghub', capabilities: ['image'], generateImage: generate });
    await generateImage({ provider: 'runninghub', model: 'runninghub/test-image', nodeId: 'target',
      prompt: '@{second:二} @{first:一} @{video:视频} @{audio:声音}', image_urls: [media.first] });
    expect(captured?.imageUrls).toEqual([media.first, media.second]);
    expect(captured?.referenceMedia?.filter((reference) => reference.kind === 'image').map((reference) => reference.url)).toEqual([media.first, media.second]);
    expect(captured?.referenceMedia?.filter((reference) => reference.kind === 'video').map((reference) => reference.url)).toEqual([media.video]);
    expect(captured?.prompt).toContain('图片2 图片1 视频1 音频1');
    expect(captured?.prompt).not.toContain('data:');
  });

  it('视频云工作流按用户素材顺序编译引用，不把首尾帧重排或媒体 URL 塞入正文', async () => {
    configure('video');
    await generateVideo({ provider: 'runninghubwf', model: 'runninghubwf/rh-workflow', workflowId: 'rh-workflow',
      prompt: '@{text:正文} @{second:二} @{video:视频} @{audio:声音}',
      referenceMedia: [
        { kind: 'image', url: media.lastFrame, origin: 'connection', role: 'last_frame' },
        { kind: 'image', url: media.firstFrame, origin: 'connection', role: 'first_frame' },
      ] });
    const request = mocks.workflow.mock.calls[0][0];
    expect(request.references).toEqual({ image: [media.lastFrame, media.firstFrame, media.second], video: [media.video], audio: [media.audio] });
    expect(request.prompt).toContain('当前节点正文 图片3 视频1 音频1');
    expect(request.prompt).not.toContain('data:');
  });

  it('RH 标准视频模型也保留显式首尾帧与参考图的顺序', async () => {
    configure('video');
    let captured: VideoGenerationReferenceInput | undefined;
    vi.spyOn(mediaProviderRegistry, 'getVideoAdapter').mockReturnValue({ providerId: 'runninghub', capabilities: ['video'],
      generateVideo: async ({ resolveReferenceInput }) => {
        captured = await resolveReferenceInput();
        return { url: 'https://cdn.example/output.mp4' };
      },
    });
    await generateVideo({ provider: 'runninghub', model: 'runninghub/test-video', prompt: '@{second:二}', referenceMedia: [
      { kind: 'image', url: media.lastFrame, origin: 'connection', role: 'last_frame' },
      { kind: 'image', url: media.firstFrame, origin: 'connection', role: 'first_frame' },
    ] });
    expect(captured?.imageUrls).toEqual([media.lastFrame, media.firstFrame, media.second]);
    expect(captured?.prompt).toBe('图片3');
  });

  it.each([
    ['image', false, undefined], ['image', true, undefined], ['video', false, undefined], ['video', true, undefined],
    ['video', true, 'annotated'],
  ] as const)('%s 保留另一节点的共享原图（显式原图：%s，来源：%s）', async (kind, explicitOriginal, sourceNodeId) => {
    configure(kind);
    const original = 'https://cdn.example/shared-original.png';
    const annotated = 'data:image/png;base64,YW5ub3RhdGVk';
    vi.spyOn(imageUtils, 'mergeImageWithOverlays').mockResolvedValue(annotated);
    useAppStore.setState({ nodes: [
      { id: 'annotated', type: 'source-image', position: { x: 0, y: 0 },
        data: { type: 'source-image', label: '标注图', imageUrl: original, annotation: 'annotation-fixture' } },
      { id: 'original', type: 'source-image', position: { x: 0, y: 0 },
        data: { type: 'source-image', label: '原图', imageUrl: original } },
    ], edges: [{ id: 'keep-original', source: 'original', target: 'target' }] });
    const params = { provider: 'runninghubwf', model: 'runninghubwf/rh-workflow', workflowId: 'rh-workflow',
      nodeId: 'target', prompt: '参考 @{annotated:标注图}' };
    if (kind === 'image') await generateImage({ ...params, image_urls: explicitOriginal ? [original] : undefined });
    else await generateVideo({ ...params, referenceMedia: explicitOriginal
      ? [{ kind: 'image', url: original, origin: 'connection', role: 'reference', sourceNodeId }] : undefined });
    const request = mocks.workflow.mock.calls[0][0];
    const bareOriginalFirst = explicitOriginal && !sourceNodeId;
    expect(request.references.image).toEqual(bareOriginalFirst ? [original, annotated] : [annotated, original]);
    expect(request.prompt).toContain(bareOriginalFirst ? '参考 图片2' : '参考 图片1');
  });

  it('未声明用途的音频云工作流剥离全部素材标记，仍独立传递三类素材', async () => {
    configure('audio');
    await generateAudio({ provider: 'runninghubwf', model: 'runninghubwf/rh-workflow', workflowId: 'rh-workflow', nodeId: 'target',
      prompt: '@{text:正文} @{second:二} @{audio:声音} @{video:视频} @{first:一}' });
    const request = mocks.workflow.mock.calls[0][0];
    expect(request.references).toEqual({ image: [media.second, media.first], video: [media.video], audio: [media.audio] });
    expect(request.prompt).toBe('当前节点正文');
    expect(request.prompt).not.toContain('data:');
    expect(request.prompt).not.toContain(oldImageUrl);
  });

  it('RH 语音入口只传朗读正文，素材编号与角色对应说明不进入正文', async () => {
    configure('audio');
    let captured: AudioProviderRequest | undefined;
    vi.spyOn(mediaProviderRegistry, 'getAudioAdapter').mockReturnValue({ providerId: 'runninghub', capabilities: ['audio'],
      generateAudio: async (request) => {
        captured = request;
        return { url: 'https://cdn.example/output.wav' };
      },
    });
    await generateAudio({ provider: 'runninghub', model: 'runninghub/rhart-audio/text-to-audio/speech-2.8-hd', nodeId: 'target',
      prompt: '@{text:正文} @{first:一} @{video:视频} @{audio:声音}' });
    expect(captured?.prompt).toBe('当前节点正文');
    expect(captured?.referenceAudioUrls).toEqual([media.audio]);
    expect(captured?.referenceMedia?.map((reference) => reference.url)).toEqual([media.first, media.video, media.audio]);
  });

  it('明确的 RH 音乐合同保留参考音频编号', async () => {
    configure('audio');
    let captured: AudioProviderRequest | undefined;
    vi.spyOn(mediaProviderRegistry, 'getAudioAdapter').mockReturnValue({ providerId: 'runninghub', capabilities: ['audio'],
      generateAudio: async (request) => {
        captured = request;
        return { url: 'https://cdn.example/music.wav' };
      },
    });
    await generateAudio({ provider: 'runninghub', model: 'runninghub/rhart-audio/text-to-audio/music-2.5',
      prompt: '参考 @{audio:声音} 的旋律' });
    expect(captured?.prompt).toBe('参考 音频1 的旋律');
    expect(captured?.referenceAudioUrls).toEqual([media.audio]);
  });
});
