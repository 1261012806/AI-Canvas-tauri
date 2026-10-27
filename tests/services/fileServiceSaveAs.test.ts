import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  save: vi.fn(),
  readFile: vi.fn(),
  writeFile: vi.fn(),
  exists: vi.fn(),
  invoke: vi.fn(),
  listen: vi.fn(),
  nativeComfy: vi.fn(() => false),
  convertFileSrc: vi.fn((p: string) => `asset://localhost/${encodeURIComponent(p)}`),
}));

vi.mock('@tauri-apps/plugin-fs', () => ({
  exists: mocks.exists,
  mkdir: vi.fn(),
  readDir: vi.fn(),
  readFile: mocks.readFile,
  rename: vi.fn(),
  stat: vi.fn(),
  writeFile: mocks.writeFile,
}));
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: vi.fn(), save: mocks.save }));
vi.mock('@tauri-apps/api/core', () => ({ convertFileSrc: mocks.convertFileSrc, invoke: mocks.invoke }));
vi.mock('@tauri-apps/api/event', () => ({ listen: mocks.listen }));
vi.mock('../../src/services/comfyImageSource', () => ({ shouldLoadNativeComfyImage: mocks.nativeComfy }));
vi.mock('@tauri-apps/api/path', () => ({ appDataDir: vi.fn(), localDataDir: vi.fn() }));
vi.mock('../../src/services/fs/core', () => ({
  CATEGORY_EXTENSIONS: {},
  arrayBufferToBase64: vi.fn(),
  buildNodeFileName: vi.fn(),
  ensureProjectDataDir: vi.fn(),
  getConvertFileSrc: () => null,
  getFileCategory: vi.fn(),
  getMimeType: vi.fn(),
  getProjectDataDir: vi.fn(),
  isTauriEnv: () => true,
  joinPath: (...parts: string[]) => parts.join('/'),
  notifyProjectDiskChanged: vi.fn(),
  resolveUniqueDestPath: vi.fn(),
  sanitizeFileName: (name: string) => name,
  sanitizeFolderName: (name: string) => name,
  stripVerbatimPrefix: (p: string) => p,
}));

import { saveNodeOutputToFile, type NodeOutputDownloadProgress } from '../../src/services/fileService';

/** mac 的 asset URL 形如 asset://localhost/<encoded path>；Windows 是 http://asset.localhost/… */
const MAC_ASSET_URL = 'asset://localhost/%2FUsers%2Fme%2FLibrary%2Fout.png';

describe('saveNodeOutputToFile', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.readFile.mockReset();
    mocks.exists.mockResolvedValue(false);
    mocks.nativeComfy.mockReset().mockReturnValue(false);
    mocks.listen.mockReset().mockResolvedValue(vi.fn());
    mocks.invoke.mockReset();
    mocks.save.mockResolvedValue('/Users/me/Desktop/out.png');
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      // 只有原样的 asset URL 才可读；被 convertFileSrc 二次编码后取不到文件
      if (url !== MAC_ASSET_URL) return { ok: false, status: 404 };
      return { ok: true, status: 200, arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer };
    }));
  });

  it('mac 的 asset:// URL 直接 fetch，不再二次 convertFileSrc', async () => {
    const dest = await saveNodeOutputToFile({
      mediaUrl: MAC_ASSET_URL,
      nodeType: 'ai-image',
      fileName: 'out.png',
    });

    expect(dest).toBe('/Users/me/Desktop/out.png');
    expect(mocks.convertFileSrc).not.toHaveBeenCalled();
    expect(mocks.writeFile).toHaveBeenCalledWith(dest, new Uint8Array([1, 2, 3]));
  });

  it('ComfyUI 原始取件另存为使用原生流下载，不经浏览器或整包内存写入', async () => {
    const source = 'http://127.0.0.1:8188/view?filename=video.mp4&type=output';
    mocks.nativeComfy.mockReturnValue(true);
    mocks.invoke.mockResolvedValue({ path: '/Users/me/Desktop/out.png', totalBytes: 10, contentType: 'video/mp4' });
    const onProgress = vi.fn();
    await expect(saveNodeOutputToFile({ mediaUrl: source, nodeType: 'ai-video', onProgress })).resolves.toBe('/Users/me/Desktop/out.png');
    expect(mocks.invoke).toHaveBeenCalledWith('download_file_streamed', expect.objectContaining({
      url: source, destinationPath: '/Users/me/Desktop/out.png', expectedMediaKind: 'video',
    }));
    expect(onProgress).toHaveBeenCalledWith({ transferredBytes: 0, totalBytes: null, phase: 'downloading' });
    expect(onProgress).toHaveBeenLastCalledWith({ transferredBytes: 10, totalBytes: 10, phase: 'saving' });
    expect(fetch).not.toHaveBeenCalled();
    expect(mocks.writeFile).not.toHaveBeenCalled();
  });

  it('ComfyUI 原生下载失败不回退浏览器读取，也不覆盖已有目标', async () => {
    const source = 'http://127.0.0.1:8188/view?filename=image.png&type=output';
    mocks.nativeComfy.mockReturnValue(true);
    mocks.exists.mockResolvedValue(true);
    await expect(saveNodeOutputToFile({ mediaUrl: source, nodeType: 'ai-image' })).rejects.toThrow('目标文件已存在，请改用新文件名');
    expect(mocks.invoke).not.toHaveBeenCalled();
    mocks.exists.mockResolvedValue(false);
    mocks.invoke.mockRejectedValue(new Error('HTTP 403'));
    await expect(saveNodeOutputToFile({ mediaUrl: source, nodeType: 'ai-image' })).rejects.toThrow('HTTP 403');
    expect(fetch).not.toHaveBeenCalled();
    expect(mocks.writeFile).not.toHaveBeenCalled();
  });

  it('取消 ComfyUI 原生另存为会取消同一传输任务，不触发内存写入', async () => {
    mocks.nativeComfy.mockReturnValue(true);
    const controller = new AbortController();
    let stop!: (error: Error) => void;
    mocks.invoke.mockImplementation((command: string) => command === 'download_file_streamed'
      ? new Promise((_resolve, reject) => { stop = reject; })
      : Promise.resolve(stop(new DOMException('cancelled', 'AbortError'))));
    const task = saveNodeOutputToFile({
      mediaUrl: 'http://127.0.0.1:8188/view?filename=video.mp4', nodeType: 'ai-video', signal: controller.signal,
    });
    const rejected = expect(task).rejects.toMatchObject({ name: 'AbortError' });
    await vi.waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith('download_file_streamed', expect.any(Object)));
    const taskId = (mocks.invoke.mock.calls[0][1] as { taskId: string }).taskId;
    controller.abort(); await rejected;
    expect(mocks.invoke).toHaveBeenCalledWith('cancel_file_transfer', { taskId });
    expect(fetch).not.toHaveBeenCalled();
    expect(mocks.writeFile).not.toHaveBeenCalled();
  });

  it('源文件读不出来时回退到节点 URL', async () => {
    mocks.readFile.mockRejectedValue(new Error('ENOENT'));

    const dest = await saveNodeOutputToFile({
      filePath: '/gone/out.png',
      mediaUrl: MAC_ASSET_URL,
      nodeType: 'ai-image',
      fileName: 'out.png',
    });

    expect(dest).toBe('/Users/me/Desktop/out.png');
    expect(mocks.writeFile).toHaveBeenCalledWith(dest, new Uint8Array([1, 2, 3]));
  });

  it('没有任何可回退内容时仍然抛错', async () => {
    mocks.readFile.mockRejectedValue(new Error('ENOENT'));
    await expect(
      saveNodeOutputToFile({ filePath: '/gone/out.png', nodeType: 'ai-image' }),
    ).rejects.toThrow('ENOENT');
  });

  it('远程媒体逐块报告真实下载字节并无损保存', async () => {
    const bytes = new Uint8Array([99, 0, 255, 128, 3, 17, 88]);
    const progress: NodeOutputDownloadProgress[] = [];
    vi.mocked(fetch).mockResolvedValue(new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes.subarray(1, 3));
        controller.enqueue(bytes.subarray(3, 6));
        controller.close();
      },
    }), { headers: { 'content-length': '5' } }));

    const dest = await saveNodeOutputToFile({
      mediaUrl: 'https://example.com/out.png',
      nodeType: 'ai-image',
      fileName: 'out.png',
      onProgress: (value) => progress.push(value),
    });

    expect(progress.filter(({ phase, transferredBytes }) => phase === 'downloading' && transferredBytes > 0))
      .toEqual([
        { transferredBytes: 2, totalBytes: 5, phase: 'downloading' },
        { transferredBytes: 5, totalBytes: 5, phase: 'downloading' },
      ]);
    expect(progress.at(-1)).toEqual({ transferredBytes: 5, totalBytes: 5, phase: 'saving' });
    expect(dest).toBe('/Users/me/Desktop/out.png');
    expect(mocks.writeFile).toHaveBeenCalledWith(dest, new Uint8Array([0, 255, 128, 3, 17]));
  });

  it('下载进度回调中取消后不写入用户选择的目标文件', async () => {
    const controller = new AbortController();
    const progress: NodeOutputDownloadProgress[] = [];
    vi.mocked(fetch).mockResolvedValue(new Response(new ReadableStream<Uint8Array>({
      start(stream) {
        stream.enqueue(new Uint8Array([1, 2]));
        stream.enqueue(new Uint8Array([3, 4]));
        stream.close();
      },
    }), { headers: { 'content-length': '4' } }));

    await expect(saveNodeOutputToFile({
      mediaUrl: 'https://example.com/out.png',
      nodeType: 'ai-image',
      signal: controller.signal,
      onProgress: (value) => {
        progress.push(value);
        if (value.transferredBytes > 0) controller.abort();
      },
    })).rejects.toMatchObject({ name: 'AbortError' });

    expect(mocks.save).toHaveBeenCalledOnce();
    expect(progress.at(-1)).toEqual({ transferredBytes: 2, totalBytes: 4, phase: 'downloading' });
    expect(mocks.writeFile).not.toHaveBeenCalled();
  });

  it('远程响应短于声明长度时拒绝保存且不覆盖目标文件', async () => {
    const onProgress = vi.fn();
    vi.mocked(fetch).mockResolvedValue(new Response(new Uint8Array([1, 2, 3]), {
      headers: { 'content-length': '5' },
    }));

    await expect(saveNodeOutputToFile({
      mediaUrl: 'https://example.com/out.png',
      nodeType: 'ai-image',
      onProgress,
    })).rejects.toThrow('媒体下载不完整');

    expect(onProgress).toHaveBeenCalledWith({ transferredBytes: 3, totalBytes: 5, phase: 'downloading' });
    expect(onProgress).not.toHaveBeenCalledWith(expect.objectContaining({ phase: 'saving' }));
    expect(mocks.writeFile).not.toHaveBeenCalled();
  });

  it.each(['wav', 'mp3', 'ogg', 'flac', 'aac', 'm4a', 'wma', 'opus'])(
    '上传的 %s 音频另存为保留原扩展名和文件字节',
    async (extension) => {
      const bytes = new Uint8Array([82, 73, 70, 70, 0, 255, 87, 65, 86, 69]);
      const filePath = `C:\\project.v1\\录音.${extension.toUpperCase()}`;
      const destPath = `/Users/me/Desktop/录音.${extension}`;
      mocks.readFile.mockResolvedValue(bytes);
      mocks.save.mockResolvedValue(destPath);

      const dest = await saveNodeOutputToFile({
        filePath,
        fileName: `录音.${extension.toUpperCase()}`,
        nodeType: 'ai-audio',
      });

      expect(dest).toBe(destPath);
      expect(mocks.save).toHaveBeenCalledWith({
        defaultPath: `录音.${extension}`,
        filters: [{ name: '音频文件', extensions: [extension] }, { name: '所有文件', extensions: ['*'] }],
      });
      expect(mocks.readFile).toHaveBeenCalledWith(filePath);
      expect(mocks.writeFile).toHaveBeenCalledWith(dest, bytes);
    },
  );

  it('音频本地文件的格式优先于展示文件名', async () => {
    mocks.readFile.mockResolvedValue(new Uint8Array([1, 2, 3]));
    await saveNodeOutputToFile({
      filePath: '/project/录音.wav',
      fileName: '已改名.mp3',
      nodeType: 'source-audio',
    });

    expect(mocks.save).toHaveBeenCalledWith(expect.objectContaining({ defaultPath: '已改名.wav' }));
  });

  it.each([
    { fileName: '录音.flac', mediaUrl: 'data:application/octet-stream;base64,AQID', defaultPath: '录音.flac' },
    { mediaUrl: 'data:audio/x-wav;base64,AQID', defaultPath: 'output.wav' },
    { mediaUrl: 'data:audio/flac;base64,AQID', defaultPath: 'output.flac' },
    { mediaUrl: 'data:audio/mp4;base64,AQID', defaultPath: 'output.m4a' },
    { mediaUrl: MAC_ASSET_URL.replace('out.png', '录音.wav'), defaultPath: 'output.wav' },
    { mediaUrl: 'https://example.com/view?filename=录音.ogg', defaultPath: 'output.ogg' },
  ])('无本地路径时从文件名或媒体格式推断 $defaultPath', async ({ defaultPath, ...source }) => {
    const destPath = `/Users/me/Desktop/${defaultPath}`;
    mocks.save.mockResolvedValue(destPath);
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
    } as Response);

    await saveNodeOutputToFile({ ...source, nodeType: 'ai-audio' });

    expect(mocks.save).toHaveBeenCalledWith(expect.objectContaining({
      defaultPath,
      filters: [{ name: '音频文件', extensions: [defaultPath.split('.').pop()] }, { name: '所有文件', extensions: ['*'] }],
    }));
    expect(mocks.writeFile).toHaveBeenCalledWith(destPath, new Uint8Array([1, 2, 3]));
  });

  it('取消音频另存为不读取或写入文件', async () => {
    mocks.save.mockResolvedValue(null);
    await expect(saveNodeOutputToFile({
      filePath: '/project/录音.wav',
      fileName: '录音.wav',
      nodeType: 'ai-audio',
    })).resolves.toBeNull();
    expect(mocks.readFile).not.toHaveBeenCalled();
    expect(mocks.writeFile).not.toHaveBeenCalled();
  });
});
