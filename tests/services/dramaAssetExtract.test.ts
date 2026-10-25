import { describe, expect, it } from 'vitest';
import {
  extractJsonObject,
  mergeDramaExtractIntoLibrary,
  normalizeAssetKey,
  parseDramaExtractResponse,
  postProcessDramaExtractOutput,
  prepareDramaExtractPrompt,
} from '../../src/services/dramaAssetExtract';
import { fillTemplate, getSlashCommands } from '../../src/components/nodes/shared/slashCommands';
import { resolveProjectGenerationPrompt } from '../../src/services/projectSettingsService';
import {
  buildDramaAssetImagePrompt,
  buildCharacterLookbookPrompt,
  formatDramaAssetTextBrief,
  listDramaAssetsFlat,
} from '../../src/services/dramaAssetPrompt';
import type { DramaAssetLibrary, DramaCharacter } from '../../src/types/dramaAssets';
import {
  emptyDramaAssetLibrary,
  normalizeDramaAssetLibrary,
} from '../../src/types/dramaAssets';
import { DRAMA_EXTRACT_MARKER } from '../../src/types/dramaAssets';

const extractCommands = ['text-extract-characters', 'text-extract-scenes', 'text-extract-props'].map((id) => (
  getSlashCommands('ai-text').find((command) => command.id === id)!
));

describe('prepareDramaExtractPrompt', () => {
  it.each(extractCommands)('$id fills the empty built-in body with the current uploaded text', (command) => {
    const prompt = fillTemplate(command.promptTemplate!, '');
    const output = '# 第一场\n林小满在电影院找到了旧运动鞋。\n';
    expect(prepareDramaExtractPrompt(prompt, output)).toBe(`${prompt}${output}`);
  });

  it.each(extractCommands)('$id keeps an explicitly filled body instead of old output', (command) => {
    const prompt = fillTemplate(command.promptTemplate!, '当前剧本正文');
    expect(prepareDramaExtractPrompt(prompt, '旧结果')).toBe(prompt);
  });

  it.each(extractCommands)('$id keeps the toolbar source mention before its empty body', (command) => {
    const prompt = `@{source-node:03-EP01分镜执行单.md}\n${fillTemplate(command.promptTemplate!, '')}`;
    expect(prepareDramaExtractPrompt(prompt)).toBe(prompt);
  });

  it.each(extractCommands)('$id rejects an empty source locally', (command) => {
    const prompt = fillTemplate(command.promptTemplate!, '');
    expect(() => prepareDramaExtractPrompt(prompt)).toThrow('缺少剧本正文');
    expect(() => prepareDramaExtractPrompt(prompt, ' \n\t')).toThrow('原内容已保留');
  });

  it('replaces an unfilled placeholder and preserves CRLF plus the source bytes', () => {
    const prompt = extractCommands[0].promptTemplate!.replace(/\n/g, '\r\n');
    const output = '  剧本第一行\r\n第二行  ';
    const prepared = prepareDramaExtractPrompt(prompt, output);
    expect(prepared).toBe(prompt.replace('{{ 文章内容 }}', output));
  });

  it('fills whitespace after a body heading even when it has no final newline', () => {
    const prompt = `${DRAMA_EXTRACT_MARKER.scene}\n# 剧本正文  `;
    expect(prepareDramaExtractPrompt(prompt, '电影院场景')).toBe(`${prompt}\n电影院场景`);
    expect(prepareDramaExtractPrompt(`${prompt}\n \t\n`, '电影院场景')).toBe(`${prompt}\n电影院场景`);
  });

  it('leaves ordinary prompts and existing custom extraction prompts unchanged', () => {
    const ordinary = '# 剧本正文\n{{ 文章内容 }}';
    expect(prepareDramaExtractPrompt(ordinary)).toBe(ordinary);
    const custom = `${DRAMA_EXTRACT_MARKER.prop}\n直接分析这段自定义剧本`;
    expect(prepareDramaExtractPrompt(custom, '旧结果')).toBe(custom);
  });

  it('fills the raw body before project text suffixes are appended', () => {
    const rawPrompt = fillTemplate(extractCommands[0].promptTemplate!, '');
    const prompt = prepareDramaExtractPrompt(rawPrompt, '林小满走进影院。');
    const effective = resolveProjectGenerationPrompt({
      prompt,
      data: { type: 'ai-text', label: '上传剧本' },
      settings: { promptSuffixes: { text: '保持简洁' } },
    });
    expect(effective).toBe(`${rawPrompt}林小满走进影院。\n\n保持简洁`);
    expect(() => prepareDramaExtractPrompt(rawPrompt)).toThrow('缺少剧本正文');
  });
});

describe('normalizeAssetKey', () => {
  it('strips spaces and punctuation', () => {
    expect(normalizeAssetKey('沈 仪')).toBe('沈仪');
    expect(normalizeAssetKey('现代电影院（夜）')).toBe('现代电影院');
  });
});

describe('parseDramaExtractResponse', () => {
  it('parses character JSON and rejects lookbook instructions in shape', () => {
    const raw = JSON.stringify({
      kind: 'character',
      items: [
        {
          name: '主角',
          identity: '都市上班族',
          summary: '电影院独坐的中年男人',
          visualNotes: '短黑发，疲惫眼神，深灰卫衣',
          wardrobeDefault: '深灰卫衣+黑裤',
          importance: 'main',
        },
      ],
    });
    const parsed = parseDramaExtractResponse(raw, 'character');
    expect(parsed.kind).toBe('character');
    expect(parsed.characters).toHaveLength(1);
    expect(parsed.characters[0].name).toBe('主角');
    expect(parsed.characters[0].identity).toBe('都市上班族');
    expect(parsed.scenes).toHaveLength(0);
  });

  it('parses fenced JSON for scenes', () => {
    const raw = '```json\n' + JSON.stringify({
      kind: 'scene',
      items: [{ name: '电影院', summary: '暗场银幕', visualNotes: '冷光', importance: 'main' }],
    }) + '\n```';
    const parsed = parseDramaExtractResponse(raw, 'scene');
    expect(parsed.scenes[0].name).toBe('电影院');
  });

  it('throws on empty items', () => {
    expect(() =>
      parseDramaExtractResponse(JSON.stringify({ kind: 'prop', items: [] }), 'prop'),
    ).toThrow(/items/);
  });
});

describe('postProcessDramaExtractOutput', () => {
  it('returns markdown and parsed on success (人物)', () => {
    const prompt = `${DRAMA_EXTRACT_MARKER.character}\n剧本…`;
    const json = JSON.stringify({
      kind: 'character',
      items: [
        {
          name: '阿宁',
          identity: '学生',
          summary: '安静的女孩',
          visualNotes: '齐肩发',
          importance: 'main',
        },
      ],
    });
    const result = postProcessDramaExtractOutput(prompt, json);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error);
    expect(result.kind).toBe('character');
    expect(result.parsed?.characters[0].name).toBe('阿宁');
    expect(result.output).toContain('人物');
    expect(result.output).toContain('阿宁');
  });

  it('parses and formats scene extract like character', () => {
    const prompt = `${DRAMA_EXTRACT_MARKER.scene}\n剧本…`;
    const json = JSON.stringify({
      kind: 'scene',
      items: [
        {
          name: '现代电影院',
          placeType: '室内',
          timeOfDay: '夜',
          summary: '银幕光映照的观众席',
          visualNotes: '暗场、银幕冷光',
          atmosphere: '孤寂',
          importance: 'main',
        },
      ],
    });
    const result = postProcessDramaExtractOutput(prompt, json);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error);
    expect(result.kind).toBe('scene');
    expect(result.parsed?.scenes[0].name).toBe('现代电影院');
    expect(result.output).toContain('场景');
    expect(result.output).toContain('现代电影院');
  });

  it('parses and formats prop extract like character', () => {
    const prompt = `${DRAMA_EXTRACT_MARKER.prop}\n剧本…`;
    const json = JSON.stringify({
      kind: 'prop',
      items: [
        {
          name: '旧运动鞋',
          ownerName: '主角',
          category: '服饰/鞋履',
          summary: '青春记忆符号',
          visualNotes: '磨损鞋面',
          significance: '人物识别点',
          importance: 'supporting',
        },
      ],
    });
    const result = postProcessDramaExtractOutput(prompt, json);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error);
    expect(result.kind).toBe('prop');
    expect(result.parsed?.props[0].name).toBe('旧运动鞋');
    expect(result.output).toContain('道具');
    expect(result.output).toContain('旧运动鞋');
  });

  it.each([
    ['not JSON: private-source-body', '未找到可解析的 JSON 对象'],
    ['{"kind":"scene","items":[private-source-body]}', '不是有效 JSON'],
    [JSON.stringify({ kind: 'scene', items: [], notes: 'private-source-body' }), 'items 为空'],
    [JSON.stringify({ kind: 'character', items: [{ name: 'private-source-body' }] }), '资产类型与提取指令不一致'],
    [JSON.stringify({ kind: 'private-source-body', items: [] }), '资产类型无效'],
    [JSON.stringify({ kind: 'scene', items: [{ summary: 'private-source-body' }] }), '第 1 条缺少 name'],
  ])('does not expose an output or raw response after extraction failure', (raw, reason) => {
    const result = postProcessDramaExtractOutput(DRAMA_EXTRACT_MARKER.scene, raw);
    expect(result).toMatchObject({ ok: false, kind: 'scene', error: expect.stringContaining(reason) });
    expect(result).not.toHaveProperty('output');
    expect(result.parsed).toBeUndefined();
    if (result.ok) throw new Error('extraction unexpectedly succeeded');
    expect(result.error).toContain('原内容已保留');
    expect(JSON.stringify(result)).not.toContain('private-source-body');
  });

  it('returns ordinary non-extraction text without parsing it', () => {
    expect(postProcessDramaExtractOutput('普通写作请求', '原始模型结果')).toEqual({ ok: true, output: '原始模型结果' });
  });
});

describe('mergeDramaExtractIntoLibrary', () => {
  it('preserves id and image bindings on re-extract same name', () => {
    const existing: DramaAssetLibrary = {
      version: 2,
      characters: [
        {
          kind: 'character',
          id: 'char_keep_me',
          key: '主角',
          name: '主角',
          summary: '旧简介',
          visualNotes: '旧外形',
          identity: '旧身份',
          importance: 'main',
          confirmed: true,
          createdAt: 1000,
          updatedAt: 1000,
          source: 'ai',
          imageNodeId: 'node-img-1',
          imageUrl: 'https://example.com/a.png',
          referenceImages: [
            {
              id: 'ref-1',
              kind: 'primary',
              imageUrl: 'https://example.com/a.png',
              sourceNodeId: 'node-img-1',
              prompt: '旧提示词',
              createdAt: 1000,
              updatedAt: 1000,
            },
          ],
          primaryReferenceImageId: 'ref-1',
        },
      ],
      scenes: [],
      props: [],
    };

    const parsed = parseDramaExtractResponse(
      JSON.stringify({
        kind: 'character',
        items: [
          {
            name: '主角',
            identity: '新身份',
            summary: '新简介',
            visualNotes: '新外形',
            importance: 'main',
          },
        ],
      }),
      'character',
    );

    const next = mergeDramaExtractIntoLibrary(existing, parsed);
    expect(next.characters).toHaveLength(1);
    expect(next.characters[0].id).toBe('char_keep_me');
    expect(next.characters[0].imageNodeId).toBe('node-img-1');
    expect(next.characters[0].imageUrl).toBe('https://example.com/a.png');
    expect(next.characters[0].referenceImages).toEqual(existing.characters[0].referenceImages);
    expect(next.characters[0].primaryReferenceImageId).toBe('ref-1');
    expect(next.characters[0].confirmed).toBe(true);
    expect(next.characters[0].summary).toBe('新简介');
    expect(next.characters[0].identity).toBe('新身份');
    expect(next.characters[0].source).toBe('merge');
  });

  it('appends new characters without dropping existing', () => {
    const existing = emptyDramaAssetLibrary();
    existing.characters.push({
      kind: 'character',
      id: 'c1',
      key: '甲',
      name: '甲',
      summary: '甲',
      visualNotes: '',
      identity: '甲',
      importance: 'main',
      confirmed: false,
      createdAt: 1,
      updatedAt: 1,
      source: 'ai',
    });
    const parsed = parseDramaExtractResponse(
      JSON.stringify({
        kind: 'character',
        items: [{ name: '乙', identity: '乙', summary: '乙', visualNotes: '', importance: 'minor' }],
      }),
      'character',
    );
    const next = mergeDramaExtractIntoLibrary(existing, parsed);
    expect(next.characters.map((c) => c.name).sort()).toEqual(['乙', '甲']);
  });
});

describe('normalizeDramaAssetLibrary', () => {
  it('migrates a v1 character image binding into the first reference image', () => {
    const library = normalizeDramaAssetLibrary({
      version: 1,
      characters: [
        {
          kind: 'character',
          id: 'legacy-character',
          key: '旧角色',
          name: '旧角色',
          summary: '简介',
          visualNotes: '外形',
          identity: '身份',
          importance: 'main',
          imageNodeId: 'legacy-node',
          imageUrl: 'data:image/png;base64,legacy',
          confirmed: true,
          createdAt: 10,
          updatedAt: 20,
          source: 'manual',
        },
      ],
      scenes: [],
      props: [],
    });

    expect(library.version).toBe(2);
    expect(library.characters[0].referenceImages).toEqual([
      expect.objectContaining({
        id: 'ref-legacy-character-legacy',
        kind: 'primary',
        imageUrl: 'data:image/png;base64,legacy',
        sourceNodeId: 'legacy-node',
      }),
    ]);
    expect(library.characters[0].primaryReferenceImageId).toBe('ref-legacy-character-legacy');
  });

  it('does not duplicate an already migrated reference image', () => {
    const reference = {
      id: 'ref-existing',
      kind: 'full_body' as const,
      imageUrl: 'https://example.com/full.png',
      prompt: '全身',
      createdAt: 1,
      updatedAt: 1,
    };
    const library = normalizeDramaAssetLibrary({
      version: 2,
      characters: [{
        kind: 'character',
        id: 'current-character',
        key: '当前角色',
        name: '当前角色',
        summary: '',
        visualNotes: '',
        identity: '',
        importance: 'main',
        confirmed: true,
        createdAt: 1,
        updatedAt: 1,
        source: 'manual',
        imageNodeId: 'legacy-node',
        imageUrl: 'https://example.com/legacy.png',
        referenceImages: [reference],
        primaryReferenceImageId: reference.id,
      }],
      scenes: [],
      props: [],
    });

    expect(library.characters[0].referenceImages).toEqual([reference]);
  });
});

describe('buildDramaAssetImagePrompt', () => {
  const character: DramaCharacter = {
    kind: 'character',
    id: 'c1',
    key: '主角',
    name: '主角',
    summary: '电影院独坐的中年男人',
    visualNotes: '短黑发，深灰卫衣',
    identity: '都市上班族',
    gender: '男',
    ageBand: '约35岁',
    wardrobeDefault: '深灰卫衣+黑裤',
    importance: 'main',
    confirmed: false,
    createdAt: 1,
    updatedAt: 1,
    source: 'ai',
  };

  it('builds lookbook prompt without empty noise', () => {
    const p = buildCharacterLookbookPrompt(character);
    expect(p).toContain('定妆');
    expect(p).toContain('主角');
    expect(p).toContain('深灰卫衣');
    expect(p).not.toMatch(/undefined/);
  });

  it('routes by asset kind', () => {
    const p = buildDramaAssetImagePrompt(character);
    expect(p).toContain('lookbook');
  });

  it('formats single-asset brief for @drama without image', () => {
    const text = formatDramaAssetTextBrief(character);
    expect(text).toContain('主角');
    expect(text).toContain('外形要点');
    expect(text).toContain('默认造型');
    expect(text).toMatch(/简介：/);
    // 单条，不应像整表那样带「共 N 条」
    expect(text).not.toContain('共 ');
  });
});

describe('resolveDramaAssetImageRef', () => {
  const sample: DramaCharacter = {
    kind: 'character',
    id: 'c1',
    key: '主角',
    name: '主角',
    summary: '简介',
    visualNotes: '外形',
    identity: '身份',
    importance: 'main',
    confirmed: false,
    createdAt: 1,
    updatedAt: 1,
    source: 'ai',
  };

  it('returns null when no image yet (first lookbook gen)', async () => {
    const { resolveDramaAssetImageRef } = await import('../../src/services/dramaAssetPrompt');
    expect(resolveDramaAssetImageRef(sample, [])).toBeNull();
  });

  it('returns image when bound node has imageUrl', async () => {
    const { resolveDramaAssetImageRef } = await import('../../src/services/dramaAssetPrompt');
    const withBind = { ...sample, imageNodeId: 'node-1' };
    const ref = resolveDramaAssetImageRef(withBind, [
      { id: 'node-1', data: { imageUrl: 'https://cdn/x.png' } },
    ]);
    expect(ref).toEqual({ imageNodeId: 'node-1', imageUrl: 'https://cdn/x.png' });
  });
});

describe('listDramaAssetsFlat', () => {
  it('concatenates kinds', () => {
    const lib = emptyDramaAssetLibrary();
    expect(listDramaAssetsFlat(lib)).toEqual([]);
  });
});

describe('extractJsonObject', () => {
  it('extracts object from surrounding prose', () => {
    const obj = extractJsonObject('说明\n{"kind":"prop","items":[{"name":"刀"}]}\n完');
    expect((obj as { kind: string }).kind).toBe('prop');
  });
});
