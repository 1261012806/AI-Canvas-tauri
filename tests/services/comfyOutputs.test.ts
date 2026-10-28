import { describe, expect, it } from 'vitest';

import { findComfyOutputFile, resolveComfyOutputUrl, type ComfyOutputFile, type ComfyOutputKind } from '../../src/services/comfyOutputs';

const file = (filename: string) => ({ filename, subfolder: '', type: 'output' });

describe('findComfyOutputFile', () => {
  it('finds audio under the built-in singular "audio" key', () => {
    // ComfyUI 内置 SaveAudio / PreviewAudio 用的就是这个键名
    expect(findComfyOutputFile({ '9': { audio: [file('voice.flac')] } }, ['audio']))
      .toEqual(file('voice.flac'));
  });

  it('still finds audio under the plural "audios" key', () => {
    expect(findComfyOutputFile({ '9': { audios: [file('voice.mp3')] } }, ['audio']))
      .toEqual(file('voice.mp3'));
  });

  it('falls back to the file extension when the key name is unknown', () => {
    expect(findComfyOutputFile({ '9': { result: [file('voice.wav')] } }, ['audio']))
      .toEqual(file('voice.wav'));
  });

  it('does not mistake an image output for audio', () => {
    expect(findComfyOutputFile({ '9': { images: [file('preview.png')] } }, ['audio'])).toBeNull();
  });

  it('finds a video stored under images by extension without accepting a preview png', () => {
    expect(findComfyOutputFile({ '9': { images: [file('result.mp4')] } }, ['video']))
      .toEqual(file('result.mp4'));
    expect(findComfyOutputFile({ '9': { images: [file('preview.png')] } }, ['video']))
      .toBeNull();
  });

  it.each(['videos', 'video', 'gifs'])('does not trust the %s key to identify video content', (key) => {
    const previews = [file('preview.png'), file('preview.webp'), file('preview.gif')];
    expect(findComfyOutputFile({ '8': { [key]: previews } }, ['video'])).toBeNull();
    expect(findComfyOutputFile({ '8': { [key]: [...previews, file('result.MP4')] } }, ['video']))
      .toEqual(file('result.MP4'));
  });

  it('prefers the saved video over an earlier temporary video preview', () => {
    const preview = { ...file('preview.webm'), type: 'temp' };
    const saved = { ...file('final.mp4'), subfolder: 'video' };
    expect(findComfyOutputFile({ '1': { videos: [preview] }, '9': { gifs: [saved] } }, ['video']))
      .toEqual(saved);
    expect(findComfyOutputFile({ '1': { gifs: [preview, saved] } }, ['video'])).toEqual(saved);
    expect(findComfyOutputFile({ '1': { videos: [preview] } }, ['video'])).toEqual(preview);
  });

  it('honours the kind priority across nodes', () => {
    const outputs = {
      '8': { images: [file('frame.png')] },
      '9': { audio: [file('voice.flac')] },
    };
    expect(findComfyOutputFile(outputs, ['audio', 'image'])).toEqual(file('voice.flac'));
    expect(findComfyOutputFile(outputs, ['image', 'audio'])).toEqual(file('frame.png'));
  });

  it.each([
    ['image', 'images', 'png'], ['audio', 'audio', 'flac'], ['video', 'videos', 'mp4'],
  ] as const)('%s 先取正式输出，再兼容未声明类型及仅预览的旧工作流', (kind, key, extension) => {
    const preview = { ...file(`preview.${extension}`), type: 'temp' };
    const legacy = { filename: `legacy.${extension}` };
    const saved = file(`saved.${extension}`);
    expect(findComfyOutputFile({ '1': { [key]: [preview] }, '2': { [key]: [legacy] }, '9': { [key]: [saved] } }, [kind]))
      .toEqual(saved);
    expect(findComfyOutputFile({ '1': { [key]: [preview, legacy, saved] } }, [kind])).toEqual(saved);
    expect(findComfyOutputFile({ '1': { [key]: [preview] }, '2': { [key]: [legacy] } }, [kind])).toEqual(legacy);
    expect(findComfyOutputFile({ '1': { [key]: [preview] } }, [kind])).toEqual(preview);
  });

  it('保留媒体类型优先级，不因另一类存在正式输出而改投', () => {
    const preview = { ...file('preview.png'), type: 'temp' };
    const audio = file('saved.flac');
    const kinds: ComfyOutputKind[] = ['image', 'audio'];
    expect(findComfyOutputFile({ '1': { images: [preview] }, '9': { audio: [audio] } }, kinds)).toEqual(preview);
  });

  it('ignores entries without a filename', () => {
    expect(findComfyOutputFile({ '9': { audio: [{ subfolder: '' } as ComfyOutputFile] } }, ['audio'])).toBeNull();
  });
});

describe('resolveComfyOutputUrl', () => {
  it('builds a /view url for the matched file', () => {
    expect(
      resolveComfyOutputUrl(
        'http://comfy.test:8188',
        { '9': { audio: [{ filename: 'voice.flac', subfolder: 'audio', type: 'output' }] } },
        ['audio'],
      ),
    ).toEqual({ url: 'http://comfy.test:8188/view?filename=voice.flac&subfolder=audio&type=output' });
  });

  it('returns null when nothing matched', () => {
    expect(resolveComfyOutputUrl('http://comfy.test:8188', {}, ['audio'])).toBeNull();
  });
});
