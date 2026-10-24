import type { ComponentProps } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const driver = vi.hoisted(() => ({ open: true }));
vi.mock('react', async () => ({
  ...await vi.importActual<typeof import('react')>('react'),
  memo: <T,>(component: T) => component,
  useState: () => [driver.open, (open: boolean) => { driver.open = open; }],
  useRef: () => ({ current: null }),
  useEffect: () => undefined,
}));
vi.mock('../../src/i18n', () => ({ useT: () => (text: string) => text }));
import AudioParamSelector from '../../src/components/nodes/shared/AudioParamSelector';
import { getLibapiAudioCapability } from '../../src/services/ai/providers/libapiModelManifest';

interface ElementLike { type: unknown; props: Record<string, unknown> & { children?: unknown } }
function elements(tree: unknown): ElementLike[] {
  if (Array.isArray(tree)) return tree.flatMap(elements);
  if (!tree || typeof tree !== 'object' || !('props' in tree)) return [];
  const element = tree as ElementLike;
  return [element, ...elements(element.props.children)];
}
function render(props: ComponentProps<typeof AudioParamSelector> = {}) {
  return elements(AudioParamSelector(props));
}
function summary(tree: ElementLike[]) {
  return tree.find((element) => String(element.props.className).includes('ui-schema-pill-label'))?.props.children;
}
function formats(tree: ElementLike[]) {
  return tree.filter((element) => String(element.props.className).includes('img-rp-quality-item'))
    .map((element) => element.props.children);
}
function select(tree: ElementLike[], label: string) {
  return tree.find((element) => element.props['aria-label'] === label)?.props;
}

beforeEach(() => { driver.open = true; });

describe('LibAPI 音频参数控件', () => {
  it('GT 按已公布六声线、容器格式和连续语速显示默认与选择', () => {
    const onChangeVoice = vi.fn();
    const onChangeFormat = vi.fn();
    const onChangeSpeed = vi.fn();
    const tree = render({ capability: getLibapiAudioCapability('gt-4o-mini-tts'), onChangeVoice, onChangeFormat, onChangeSpeed });
    expect(summary(tree)).toBe('alloy · MP3 · 1x');
    expect(select(tree, '音色')?.options).toEqual(['alloy', 'echo', 'fable', 'onyx', 'nova', 'shimmer'].map((value) => ({ value, label: value })));
    expect(formats(tree)).toEqual(['MP3', 'OPUS', 'AAC', 'FLAC', 'WAV']);
    expect(tree.find((element) => element.type === 'input' && element.props.type === 'range')?.props)
      .toMatchObject({ min: 0.25, max: 4, step: 0.25, value: 1 });
    (select(tree, '音色')!.onChange as (value: string) => void)('nova');
    expect(onChangeVoice).toHaveBeenCalledExactlyOnceWith('nova');
    const wav = tree.find((element) => element.props.children === 'WAV' && typeof element.props.onClick === 'function')!;
    (wav.props.onClick as () => void)();
    expect(onChangeFormat).toHaveBeenCalledExactlyOnceWith('wav');
    expect(onChangeSpeed).not.toHaveBeenCalled();
  });

  it.each(['gm-3.1-flash-tts', 'gm-2.5-pro-tts'])('GM 型号 %s 只显示三十声线与 WAV，不借用其他平台语速', (id) => {
    const tree = render({ capability: getLibapiAudioCapability(id) });
    expect(summary(tree)).toBe('Zephyr · WAV');
    expect(select(tree, '音色')?.options).toHaveLength(30);
    expect(formats(tree)).toEqual(['WAV']);
    expect(select(tree, '语速')).toBeUndefined();
    expect(tree.some((element) => element.type === 'input' && element.props.type === 'range')).toBe(false);
  });

  it.each(['speech-2.8', 'doubao-tts-2.0'])('型号 %s 的自由音色 ID 必填，不注入 alloy 或添加克隆入口', (id) => {
    const onChangeVoice = vi.fn();
    const tree = render({ capability: getLibapiAudioCapability(id), onChangeVoice });
    const input = tree.find((element) => element.type === 'input' && element.props.placeholder === '填写平台提供的音色 ID')!;
    expect(input.props).toMatchObject({ value: '', required: true, 'aria-required': 'true', maxLength: 256 });
    expect(input.props.className).toContain('ui-input');
    expect(summary(tree)).toContain('请填写音色 ID');
    expect(summary(tree)).not.toContain('alloy');
    expect(select(tree, '语速')?.options).toHaveLength(6);
    expect(tree.some((element) => element.props.children === '+ 添加参考')).toBe(false);
    expect(formats(tree)).toEqual(id === 'speech-2.8' ? [] : ['MP3', 'WAV']);
    (input.props.onChange as (event: { target: { value: string } }) => void)({ target: { value: 'voice-platform-id' } });
    expect(onChangeVoice).toHaveBeenCalledExactlyOnceWith('voice-platform-id');
  });

  it('音乐仅保留标题和歌词，旧时长、BPM、自动歌词开关不误展示', () => {
    const tree = render({ capability: getLibapiAudioCapability('music'), musicTitle: '片尾曲', musicLyrics: '走向远方',
      musicDuration: 120, musicBpm: 90, autoGenerateLyrics: true });
    expect(summary(tree)).toBe('标题与歌词');
    expect(tree.find((element) => element.type === 'input' && element.props.maxLength === 120)?.props.value).toBe('片尾曲');
    expect(tree.find((element) => element.type === 'textarea')?.props.value).toBe('走向远方');
    expect(tree.some((element) => element.type === 'input' && ['range', 'number', 'checkbox'].includes(String(element.props.type)))).toBe(false);
    expect(select(tree, '音色')).toBeUndefined();
    expect(formats(tree)).toEqual([]);
  });

  it('没有运行期厂商合同时保留原有默认声音、格式和语速', () => {
    const tree = render({ purpose: 'speech' });
    expect(summary(tree)).toBe('alloy · WAV · 1x');
    expect(select(tree, '音色')?.options).toHaveLength(6);
    expect(formats(tree)).toEqual(['WAV', 'OPUS', 'AAC', 'FLAC', 'PCM']);
    expect(tree.find((element) => element.type === 'input' && element.props.type === 'range')?.props)
      .toMatchObject({ min: 0.25, max: 4, step: 0.05, value: 1 });
    expect(render()).toEqual([]);
  });
});
