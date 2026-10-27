import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ matches: vi.fn(), nativeFetch: vi.fn(), transcribe: vi.fn() }));
vi.mock('../../src/store/useAppStore', () => ({
  useAppStore: { getState: () => ({ config: { providers: { apimart: { apiKey: 'test-key', baseUrl: 'https://api.example' } } } }) },
}));
vi.mock('../../src/services/comfyImageSource', () => ({ shouldLoadNativeComfyImage: mocks.matches }));
vi.mock('../../src/services/ai/httpTransport', () => ({ corsSafeFetch: mocks.nativeFetch }));
vi.mock('../../src/services/ai/apimartAudio', () => ({ transcribeApimartAudio: mocks.transcribe }));

import { transcribeAudio } from '../../src/services/ai/transcribeAudio';

const source = 'http://127.0.0.1:8188/view?filename=audio.wav&type=output';
const response = () => new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'audio/wav' } });
beforeEach(() => {
  mocks.matches.mockReset().mockReturnValue(true);
  mocks.nativeFetch.mockReset().mockResolvedValue(response());
  mocks.transcribe.mockReset().mockResolvedValue('transcribed');
  vi.stubGlobal('fetch', vi.fn());
});
afterEach(() => vi.unstubAllGlobals());

describe('ComfyUI audio transcription source', () => {
  it('reads ComfyUI output bytes through the native proxy before transcription', async () => {
    await expect(transcribeAudio({ audioUrl: source, fileName: 'audio.wav' })).resolves.toBe('transcribed');
    expect(mocks.nativeFetch).toHaveBeenCalledWith(source);
    expect(mocks.transcribe).toHaveBeenCalledWith('test-key', 'https://api.example', expect.objectContaining({ file: expect.any(Blob) }));
    expect(fetch).not.toHaveBeenCalled();
  });

  it('does not retry a rejected native source in the browser or submit empty audio', async () => {
    mocks.nativeFetch.mockResolvedValue(new Response(null, { status: 403 }));
    await expect(transcribeAudio({ audioUrl: source, fileName: 'audio.wav' })).rejects.toThrow('(403)');
    expect(mocks.transcribe).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('keeps local asset audio on the existing WebView fetch path', async () => {
    mocks.matches.mockReturnValue(false);
    vi.mocked(fetch).mockResolvedValue(response());
    await transcribeAudio({ audioUrl: 'asset://audio.wav', fileName: 'audio.wav' });
    expect(fetch).toHaveBeenCalledWith('asset://audio.wav');
    expect(mocks.nativeFetch).not.toHaveBeenCalled();
  });
});
