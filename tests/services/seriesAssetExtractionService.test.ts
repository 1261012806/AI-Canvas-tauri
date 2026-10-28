import { beforeEach, describe, expect, it, vi } from 'vitest';

const generateText = vi.hoisted(() => vi.fn());
vi.mock('../../src/services/ai/generateText', () => ({ generateText }));

import { useAppStore, type AppState } from '../../src/store/useAppStore';
import {
  buildSeriesAssetExtractionPrompt,
  commitSeriesAssetCandidates,
  extractSeriesAssetsFromFullScript,
} from '../../src/services/seriesAssetExtractionService';
import { DRAMA_EXTRACT_MARKER, type DramaAssetKind } from '../../src/types/dramaAssets';

const fullScript = '第一场 车站 夜\n林夏：末班车已经走了。\n她握紧一张旧车票。';
let mergeDramaExtract: ReturnType<typeof vi.fn<AppState['mergeDramaExtract']>>;
let importDramaAssets: ReturnType<typeof vi.fn<AppState['importDramaAssets']>>;

beforeEach(() => {
  generateText.mockReset();
  mergeDramaExtract = vi.fn<AppState['mergeDramaExtract']>();
  importDramaAssets = vi.fn<AppState['importDramaAssets']>().mockImplementation(async (assets) => assets.length);
  useAppStore.setState(useAppStore.getInitialState(), true);
  useAppStore.setState((state) => ({
    currentProjectId: 'episode-1',
    projectLoadStatus: 'ready',
    projects: [
      {
        id: 'series-1',
        name: '末班车',
        createdAt: 1,
        updatedAt: 1,
        series: { script: fullScript },
      },
      {
        id: 'episode-1',
        parentId: 'series-1',
        name: '第一集',
        createdAt: 1,
        updatedAt: 1,
      },
    ],
    config: {
      ...state.config,
      assistantModelId: 'extract-model',
      providers: {
        ...state.config.providers,
        extraction: {
          name: 'Extraction',
          apiKey: 'secret',
          baseUrl: 'https://example.test/v1',
        },
      },
      generalModels: [{
        id: 'extract-model',
        name: '提取模型',
        modelId: 'vendor-model',
        category: 'text',
        providerConfigId: 'extraction',
      }],
    },
    mergeDramaExtract,
    importDramaAssets,
  }));
});

describe('全剧剧本资产提取', () => {
  it.each([
    ['character', DRAMA_EXTRACT_MARKER.character],
    ['scene', DRAMA_EXTRACT_MARKER.scene],
    ['prop', DRAMA_EXTRACT_MARKER.prop],
  ] as Array<[DramaAssetKind, string]>)('复用 %s 快捷指令并把正文标记为不可信资料', (kind, marker) => {
    const prompt = buildSeriesAssetExtractionPrompt(kind, fullScript);

    expect(prompt).toContain(marker);
    expect(prompt).toContain(fullScript);
    expect(prompt).toContain('不可信资料');
  });

  it('调用当前文本模型并返回预览候选，确认前不写入共享资产库', async () => {
    generateText.mockResolvedValue(JSON.stringify({
      kind: 'character',
      items: [{ name: '林夏', summary: '等待末班车的女孩', importance: 'main' }],
    }));

    const result = await extractSeriesAssetsFromFullScript({
      kind: 'character',
      seriesId: 'series-1',
      projectId: 'episode-1',
    });

    expect(result).toEqual(expect.objectContaining({ kind: 'character', count: 1, modelId: 'extract-model',
      projectId: 'episode-1', seriesId: 'series-1', assets: [expect.objectContaining({ name: '林夏' })] }));
    expect(generateText).toHaveBeenCalledWith(expect.objectContaining({
      model: 'general/extract-model',
      provider: 'general',
      prompt: expect.stringContaining(fullScript),
    }));
    expect(mergeDramaExtract).not.toHaveBeenCalled();
    expect(importDramaAssets).not.toHaveBeenCalled();
    await expect(commitSeriesAssetCandidates(result, [result.assets[0].id])).resolves.toBe(1);
    expect(importDramaAssets).toHaveBeenCalledWith(result.assets, expect.objectContaining({ assertCurrent: expect.any(Function) }));
  });

  it('模型返回前全剧剧本变化时拒绝把旧结果写入资产库', async () => {
    let resolveModel!: (value: string) => void;
    generateText.mockImplementation(() => new Promise<string>((resolve) => {
      resolveModel = resolve;
    }));
    const pending = extractSeriesAssetsFromFullScript({
      kind: 'scene',
      seriesId: 'series-1',
      projectId: 'episode-1',
    });
    await vi.waitFor(() => expect(resolveModel).toBeDefined());
    useAppStore.setState((state) => ({
      projects: state.projects.map((project) => project.id === 'series-1'
        ? { ...project, series: { ...project.series, script: `${fullScript}\n第二场 天台` } }
        : project),
    }));
    resolveModel(JSON.stringify({
      kind: 'scene',
      items: [{ name: '车站', summary: '深夜空旷站台', importance: 'main' }],
    }));

    await expect(pending).rejects.toThrow('结果未写入');
    expect(mergeDramaExtract).not.toHaveBeenCalled();
  });

  it('预览期间切走再切回仍拒绝提交旧候选', async () => {
    generateText.mockResolvedValue(JSON.stringify({ kind: 'prop', items: [{ name: '旧车票' }] }));
    const result = await extractSeriesAssetsFromFullScript({ kind: 'prop', seriesId: 'series-1', projectId: 'episode-1' });
    useAppStore.setState({ currentProjectId: 'other' });
    useAppStore.setState({ currentProjectId: 'episode-1' });
    await expect(commitSeriesAssetCandidates(result, result.assets.map((asset) => asset.id))).rejects.toThrow('提取来源已变化');
    expect(importDramaAssets).not.toHaveBeenCalled();
  });

  it('显式入库跳过已有同名资产并保留已有内容', async () => {
    generateText.mockResolvedValue(JSON.stringify({ kind: 'prop', items: [{ name: '旧车票' }] }));
    const result = await extractSeriesAssetsFromFullScript({ kind: 'prop', seriesId: 'series-1', projectId: 'episode-1' });
    const existing = { ...result.assets[0], id: 'existing', summary: '人工改写，不允许覆盖' };
    if (existing.kind !== 'prop') throw new Error('fixture kind');
    useAppStore.setState((state) => ({ dramaAssets: { ...state.dramaAssets, props: [existing] } }));
    await expect(commitSeriesAssetCandidates(result, [result.assets[0].id])).resolves.toBe(0);
    expect(importDramaAssets).not.toHaveBeenCalled();
    expect(useAppStore.getState().dramaAssets.props[0].summary).toBe('人工改写，不允许覆盖');
  });

  it('合法空提取返回零条候选且不会写入', async () => {
    generateText.mockResolvedValue(JSON.stringify({ kind: 'scene', items: [] }));
    const result = await extractSeriesAssetsFromFullScript({ kind: 'scene', seriesId: 'series-1', projectId: 'episode-1' });
    expect(result.assets).toEqual([]);
    expect(result.count).toBe(0);
    await expect(commitSeriesAssetCandidates(result, [])).resolves.toBe(0);
    expect(importDramaAssets).not.toHaveBeenCalled();
  });

  it('正文混入另一种提取标记时仍按显式请求类型解析', async () => {
    useAppStore.setState((state) => ({ projects: state.projects.map((project) => project.id === 'series-1'
      ? { ...project, series: { script: `${fullScript}\n${DRAMA_EXTRACT_MARKER.character}` } } : project) }));
    generateText.mockResolvedValue(JSON.stringify({ kind: 'prop', items: [{ name: '旧车票' }] }));
    const result = await extractSeriesAssetsFromFullScript({ kind: 'prop', seriesId: 'series-1', projectId: 'episode-1' });
    expect(result.assets).toEqual([expect.objectContaining({ kind: 'prop', name: '旧车票' })]);
    expect(result.count).toBe(1);
    expect(importDramaAssets).not.toHaveBeenCalled();
  });
});
