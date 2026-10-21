import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SHOT_DURATION,
  buildShotFramePrompt,
  buildShotPlaceholderText,
  collectShotFrameCandidates,
  computeShotlistDuration,
  formatShotRowBrief,
  createShotRow,
  isShotRowBlank,
  isShotRowTextOnly,
  resolveShotDuration,
  resolveShotTransitionKind,
} from '../../src/types/shotlist';
import type { ShotRow } from '../../src/types/shotlist';

function row(overrides: Partial<ShotRow> = {}): ShotRow {
  return { ...createShotRow('row-1', 1), ...overrides };
}

describe('分镜表行状态判定', () => {
  it('新建的空行算空行', () => {
    expect(isShotRowBlank(createShotRow('r', 1))).toBe(true);
  });

  it('只填了内容也不算空行', () => {
    expect(isShotRowBlank(row({ content: '警察松动警戒线' }))).toBe(false);
    expect(isShotRowTextOnly(row({ content: '警察松动警戒线' }))).toBe(true);
  });

  it('只有空白字符仍算空行', () => {
    expect(isShotRowBlank(row({ content: '   ', dialogue: '\n' }))).toBe(true);
  });

  it('绑了画面就不是纯文字行', () => {
    const bound = row({ frame: { nodeId: 'node-9', kind: 'image' } });
    expect(isShotRowBlank(bound)).toBe(false);
    expect(isShotRowTextOnly(bound)).toBe(false);
  });
});

describe('镜头时长解析', () => {
  it('优先用表里填的时长', () => {
    expect(resolveShotDuration(row({ duration: 7 }))).toBe(7);
  });

  it('视频行没填时长时回落到源片长', () => {
    const shot = row({
      duration: undefined,
      frame: { nodeId: 'n', kind: 'video', sourceDuration: 12 },
    });
    expect(resolveShotDuration(shot)).toBe(12);
  });

  it('什么都没有时用默认停留时长', () => {
    expect(resolveShotDuration(row({ duration: undefined }))).toBe(DEFAULT_SHOT_DURATION);
    // 0 和负数是无效输入，不能让片段塌成零长
    expect(resolveShotDuration(row({ duration: 0 }))).toBe(DEFAULT_SHOT_DURATION);
  });

  it('总时长跳过空行', () => {
    const rows = [
      row({ id: 'a', duration: 3, content: '甲' }),
      createShotRow('blank', 2),
      row({ id: 'c', duration: 2, content: '乙' }),
    ];
    expect(computeShotlistDuration(rows)).toBe(5);
  });
});

describe('转场映射到剪辑器', () => {
  it('认识的写法映射到对应转场', () => {
    expect(resolveShotTransitionKind('叠化')).toBe('dissolve');
    expect(resolveShotTransitionKind('淡入淡出')).toBe('fade');
    expect(resolveShotTransitionKind('切')).toBe('none');
  });

  it('剪辑器不支持的写法按硬切处理，不报错', () => {
    expect(resolveShotTransitionKind('划像')).toBe('none');
    expect(resolveShotTransitionKind('')).toBe('none');
    expect(resolveShotTransitionKind(undefined)).toBe('none');
  });
});

describe('无画面行的占位文字', () => {
  it('镜号、景别、运镜拼成抬头，内容另起一行', () => {
    const text = buildShotPlaceholderText(row({
      shotNo: '1', shotSize: '全景', camera: '固定', content: '警察松动警戒线',
    }));
    expect(text).toBe('1 · 全景 · 固定\n警察松动警戒线');
  });

  it('没有内容时退而用台词', () => {
    expect(buildShotPlaceholderText(row({ shotNo: '2', content: '', dialogue: '安警官是自己人' })))
      .toBe('2\n安警官是自己人');
  });

  it('全空也要给个能看的名字', () => {
    expect(buildShotPlaceholderText({ id: 'x', shotNo: '' })).toBe('未命名镜头');
  });
});

describe('画面格的候选与生成提示词', () => {
  const nodes = [
    { id: 'img', type: 'ai-image', data: { label: '警戒线', imageUrl: 'a.png' } },
    { id: 'vid', type: 'source-video', data: { label: '街景', videoUrl: 'b.mp4' } },
    { id: 'txt', type: 'ai-text', data: { label: '剧本' } },
    { id: 'loose', type: 'ai-image', data: { label: '没连线', imageUrl: 'c.png' } },
  ];
  const edges = [
    { source: 'img', target: 'table' },
    { source: 'vid', target: 'table' },
    { source: 'txt', target: 'table' },
    { source: 'loose', target: 'other' },
  ];

  it('只收连进本表的图像/视频节点', () => {
    expect(collectShotFrameCandidates(nodes, edges, 'table')).toEqual([
      { nodeId: 'img', label: '警戒线', kind: 'image', url: 'a.png' },
      { nodeId: 'vid', label: '街景', kind: 'video', url: 'b.mp4' },
    ]);
  });

  it('视频优先用封面帧当缩略图', () => {
    const withThumb = [{ id: 'vid', type: 'ai-video', data: { label: '街景', thumbnailUrl: 't.png', videoUrl: 'b.mp4' } }];
    expect(collectShotFrameCandidates(withThumb, [{ source: 'vid', target: 'table' }], 'table')[0].url)
      .toBe('t.png');
  });

  it('本表派生的视频无需反接即可选用，不混入其他表的成果，也不重复收录', () => {
    const produced = (id: string, nodeId: string) => ({ id, type: 'ai-video', data: {
      label: id, videoUrl: `${id}.mp4`, shotlistProductionSource: { nodeId, rowId: 'row', kind: 'video' },
    } });
    const candidates = collectShotFrameCandidates([
      produced('own', 'table'), produced('linked', 'table'), produced('other', 'another-table'),
    ], [{ source: 'linked', target: 'table' }], 'table');
    expect(candidates.map((item) => item.nodeId)).toEqual(['own', 'linked']);
    expect(candidates[0]).toMatchObject({ kind: 'video', url: 'own.mp4' });
  });

  it('生成提示词用景别、运镜修饰内容，空字段不留空档', () => {
    expect(buildShotFramePrompt(row({ shotSize: '特写', camera: '', content: '手铐扣紧' })))
      .toBe('特写，手铐扣紧');
    expect(buildShotFramePrompt(row({ shotSize: '', camera: '', content: '' }))).toBe('');
  });
});

describe('单行摘要文字', () => {
  it('空字段不留空档，时长跟着推送口径回落', () => {
    expect(formatShotRowBrief(row({ shotNo: '1', shotSize: '', camera: '推', content: '手铐扣紧', dialogue: '' })))
      .toBe('1 · 推 · 手铐扣紧 · 3″');
    expect(formatShotRowBrief(row({
      shotNo: '2', shotSize: '特写', camera: '', content: '', dialogue: '安警官是自己人', duration: 0.5,
    }))).toBe('2 · 特写 · 安警官是自己人 · 0.5″');
  });
});
