import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  createInput: vi.fn(), probe: vi.fn(), init: vi.fn(), canEncodeAudio: vi.fn(), target: undefined as { buffer: ArrayBuffer | null } | undefined,
}));
vi.mock('mediabunny', () => ({
  Conversion: { init: mocks.init },
  canEncodeAudio: mocks.canEncodeAudio,
  Mp4OutputFormat: class {},
  Output: class { options: unknown; constructor(options: unknown) { this.options = options; } },
  BufferTarget: class { buffer: ArrayBuffer | null = null; constructor() { mocks.target = this; } },
}));
vi.mock('../../src/services/videoEditorMediaService', () => ({
  createVideoInput: mocks.createInput, probeVideoSource: mocks.probe,
}));
import { createPluginVideoPlayback } from '../../src/services/plugins/pluginVideoPlaybackService';

describe('plugin continuous video playback', () => {
  const track = { isAudioTrack: () => false };
  const audioTrack = { isAudioTrack: () => true };
  const dispose = vi.fn();
  const cancel = vi.fn(async () => undefined);
  beforeEach(() => {
    vi.clearAllMocks(); mocks.target = undefined;
    mocks.createInput.mockResolvedValue({ dispose, getPrimaryVideoTrack: async () => track, getPrimaryAudioTrack: async () => audioTrack });
    mocks.canEncodeAudio.mockResolvedValue(true);
    mocks.probe.mockResolvedValue({ duration: 60, width: 1920, height: 1080, audioCodec: 'aac' });
    mocks.init.mockImplementation(async () => ({ isValid: true, utilizedTracks: [track, audioTrack], cancel,
      execute: async () => {
        mocks.target!.buffer = new Uint8Array([1, 2, 3]).buffer;
      } }));
  });
  afterEach(() => vi.unstubAllGlobals());

  it('uses continuous H264 frames at bounded dimensions, removes source tags and reports actual audio', async () => {
    const value = await createPluginVideoPlayback({ url: 'host-only', assertFresh() {} });
    expect(value).toEqual({ bytes: new Uint8Array([1, 2, 3]), duration: 60, hasAudio: true });
    expect(mocks.init.mock.calls[0][0]).toMatchObject({ tracks: 'primary', tags: {},
      video: { codec: 'avc', width: 960, height: 540, frameRate: 30, keyFrameInterval: 1 },
      audio: { codec: 'aac', bitrate: 64_000, sampleRate: 48_000, numberOfChannels: 2, forceTranscode: true } });
    expect(mocks.canEncodeAudio).toHaveBeenCalledWith('aac', { sampleRate: 48_000, numberOfChannels: 2, bitrate: 64_000 });
    expect(dispose).toHaveBeenCalledOnce();
  });

  it('accepts previews above 12 MiB and rejects excessive duration before encoding', async () => {
    mocks.probe.mockResolvedValueOnce({ duration: 301, width: 1920, height: 1080 });
    await expect(createPluginVideoPlayback({ url: 'host-only', assertFresh() {} })).rejects.toThrow('300');
    expect(mocks.init).not.toHaveBeenCalled();
    mocks.init.mockImplementationOnce(async () => ({ isValid: true, utilizedTracks: [track, audioTrack], cancel,
      execute: async () => { mocks.target!.buffer = new ArrayBuffer(20 * 1024 * 1024); } }));
    const value = await createPluginVideoPlayback({ url: 'host-only', assertFresh() {} });
    expect(value.bytes.byteLength).toBe(20 * 1024 * 1024);
  });

  it('preserves source audio without forcing transcode when AAC is unsupported', async () => {
    vi.stubGlobal('AudioEncoder', class {});
    mocks.canEncodeAudio.mockResolvedValue(false);
    const result = await createPluginVideoPlayback({ url: 'host-only', assertFresh() {} });
    expect(result.hasAudio).toBe(true);
    expect(mocks.init.mock.calls[0][0].audio).toEqual({});
  });

  it('still preserves audio when AAC probing rejects in an older WebView', async () => {
    vi.stubGlobal('AudioEncoder', undefined);
    mocks.canEncodeAudio.mockRejectedValueOnce(new Error('unsupported AAC config'));
    expect((await createPluginVideoPlayback({ url: 'host-only', assertFresh() {} })).hasAudio).toBe(true);
    expect(mocks.init.mock.calls[0][0].audio).toEqual({});
  });

  it('rejects a conversion that would discard a real source audio track', async () => {
    const execute = vi.fn();
    mocks.init.mockResolvedValueOnce({ isValid: true, utilizedTracks: [track], cancel, execute });
    await expect(createPluginVideoPlayback({ url: 'host-only', assertFresh() {} })).rejects.toThrow('无法保留视频音轨');
    expect(execute).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalled();
    expect(dispose).toHaveBeenCalledOnce();
  });

  it('only discards audio when the actual input has no audio track', async () => {
    mocks.createInput.mockResolvedValueOnce({ dispose, getPrimaryVideoTrack: async () => track, getPrimaryAudioTrack: async () => null });
    mocks.init.mockImplementationOnce(async () => ({ isValid: true, utilizedTracks: [track], cancel,
      execute: async () => { mocks.target!.buffer = new Uint8Array([1]).buffer; } }));
    const result = await createPluginVideoPlayback({ url: 'host-only', assertFresh() {} });
    expect(result.hasAudio).toBe(false);
    expect(mocks.canEncodeAudio).not.toHaveBeenCalled();
    expect(mocks.init.mock.calls[0][0].audio).toEqual({ discard: true });
  });

  it('stops cancelled or stale work and sanitizes codec failures', async () => {
    const controller = new AbortController(); controller.abort();
    await expect(createPluginVideoPlayback({ url: 'host-only', signal: controller.signal, assertFresh() {} })).rejects.toThrow('取消');
    expect(mocks.createInput).not.toHaveBeenCalled();
    await expect(createPluginVideoPlayback({ url: 'host-only', assertFresh() { throw new Error('stale source'); } })).rejects.toThrow('连续视频预览准备失败');
    mocks.init.mockRejectedValueOnce(new Error('private URL host-only'));
    await expect(createPluginVideoPlayback({ url: 'host-only', assertFresh() {} })).rejects.toThrow('连续视频预览准备失败');
    expect(dispose).toHaveBeenCalled();
  });
});
