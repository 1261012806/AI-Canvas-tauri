import { afterEach, describe, expect, it, vi } from 'vitest';

import { createResilientReader as makeReader, createVideoInput } from '../../src/services/videoEditorMediaService';

const WHOLE = new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
const readers = new Set<ReturnType<typeof makeReader>>();
const inputs: Awaited<ReturnType<typeof createVideoInput>>[] = [];
function createResilientReader(...args: Parameters<typeof makeReader>) {
  const reader = makeReader(...args);
  readers.add(reader);
  return reader;
}

function rangeResponse(start: number, end: number) {
  return {
    ok: true,
    status: 206,
    headers: new Headers({ 'Content-Range': `bytes ${start}-${end - 1}/${WHOLE.length}`, 'Content-Length': String(end - start) }),
    arrayBuffer: async () => WHOLE.slice(start, end).buffer,
  } as unknown as Response;
}

function wholeResponse() {
  return new Response(WHOLE, {
    status: 200,
    headers: { 'Content-Length': String(WHOLE.length) },
  });
}

/** WKWebView 的 asset:// 在并发分片下让 fetch 直接失败时抛的就是这个 */
function webkitFetchFailure() {
  return new TypeError('Type error');
}

afterEach(() => {
  for (const reader of readers) reader.dispose();
  readers.clear();
  for (const input of inputs.splice(0)) input.dispose();
  vi.unstubAllGlobals();
});

describe('createResilientReader', () => {
  it('serves a plain ranged read with a single request', async () => {
    const fetchMock = vi.fn(async () => rangeResponse(2, 5));
    vi.stubGlobal('fetch', fetchMock);

    const read = createResilientReader('asset://video.mp4', WHOLE.length);
    expect([...(await read(2, 5))]).toEqual([2, 3, 4]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('retries once before giving up on a ranged read', async () => {
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(webkitFetchFailure())
      .mockResolvedValueOnce(rangeResponse(0, 3));
    vi.stubGlobal('fetch', fetchMock);

    const read = createResilientReader('asset://video.mp4', WHOLE.length);
    expect([...(await read(0, 3))]).toEqual([0, 1, 2]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('falls back to a whole-file download when ranged reads keep failing', async () => {
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(webkitFetchFailure())
      .mockRejectedValueOnce(webkitFetchFailure())
      .mockResolvedValueOnce(wholeResponse());
    vi.stubGlobal('fetch', fetchMock);

    const read = createResilientReader('asset://video.mp4', WHOLE.length);
    expect([...(await read(4, 7))]).toEqual([4, 5, 6]);
    // 两次分片尝试 + 一次整份下载
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('serves every later read from memory once it fell back', async () => {
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(webkitFetchFailure())
      .mockRejectedValueOnce(webkitFetchFailure())
      .mockResolvedValueOnce(wholeResponse());
    vi.stubGlobal('fetch', fetchMock);

    const read = createResilientReader('asset://video.mp4', WHOLE.length);
    await read(0, 2);
    fetchMock.mockClear();

    expect([...(await read(7, 10))]).toEqual([7, 8, 9]);
    expect([...(await read(1, 3))]).toEqual([1, 2]);
    // 回退之后不该再碰 asset:// 一次
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does not materialize a full 200 response for a range request before switching to one shared download', async () => {
    const cancel = vi.fn(async () => undefined);
    const ignoredRangeResponse = {
      ok: true,
      status: 200,
      headers: new Headers({ 'Content-Length': '999999999' }),
      body: { cancel },
      arrayBuffer: vi.fn(async () => {
        throw new Error('range response body must not be read');
      }),
    } as unknown as Response;
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(ignoredRangeResponse)
      .mockResolvedValueOnce(wholeResponse());
    vi.stubGlobal('fetch', fetchMock);

    const read = createResilientReader('https://example.test/video.mp4', WHOLE.length);
    expect([...(await read(2, 5))]).toEqual([2, 3, 4]);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(ignoredRangeResponse.arrayBuffer).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(2);

    await read(5, 7);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('cancels an oversized 206 body before materializing it and switches to the shared download', async () => {
    const cancel = vi.fn(async () => undefined);
    const oversizedRangeResponse = {
      ok: true,
      status: 206,
      headers: new Headers({
        'Content-Length': '999999999',
        'Content-Range': `bytes 2-4/${WHOLE.length}`,
      }),
      body: { cancel },
      arrayBuffer: vi.fn(async () => {
        throw new Error('oversized range body must not be materialized');
      }),
    } as unknown as Response;
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(oversizedRangeResponse)
      .mockResolvedValueOnce(wholeResponse());
    vi.stubGlobal('fetch', fetchMock);

    const read = createResilientReader('https://example.test/video.mp4', WHOLE.length);
    expect([...(await read(2, 5))]).toEqual([2, 3, 4]);
    expect(cancel).toHaveBeenCalledOnce();
    expect(oversizedRangeResponse.arrayBuffer).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('stops a streamed 206 response as soon as it exceeds the requested range', async () => {
    const cancel = vi.fn(async () => undefined);
    const releaseLock = vi.fn();
    const readChunk = vi.fn()
      .mockResolvedValueOnce({ done: false, value: new Uint8Array([2, 3, 4, 5]) });
    const oversizedRangeResponse = {
      ok: true,
      status: 206,
      headers: new Headers({ 'Content-Range': `bytes 2-4/${WHOLE.length}` }),
      body: {
        getReader: () => ({ read: readChunk, cancel, releaseLock }),
      },
    } as unknown as Response;
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(oversizedRangeResponse)
      .mockResolvedValueOnce(wholeResponse());
    vi.stubGlobal('fetch', fetchMock);

    const read = createResilientReader('https://example.test/video.mp4', WHOLE.length);
    expect([...(await read(2, 5))]).toEqual([2, 3, 4]);
    expect(cancel).toHaveBeenCalledOnce();
    expect(releaseLock).toHaveBeenCalledOnce();
    expect(readChunk).toHaveBeenCalledOnce();
  });

  it('clamps reads that run past the end of the file', async () => {
    let requestedRange = '';
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      requestedRange = String((init?.headers as Record<string, string> | undefined)?.Range ?? '');
      return rangeResponse(8, 10);
    });
    vi.stubGlobal('fetch', fetchMock);

    const read = createResilientReader('asset://video.mp4', WHOLE.length);
    expect([...(await read(8, 999))]).toEqual([8, 9]);
    // 越界的 end 必须夹到文件长度，否则 Range 头会请求不存在的字节
    expect(requestedRange).toBe('bytes=8-9');
  });

  it('keeps large files on the range path but refuses an oversized whole-file fallback', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(rangeResponse(0, 2))
      .mockResolvedValueOnce(new Response(null, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const read = createResilientReader('asset://large.mp4', 65 * 1024 * 1024);
    expect([...(await read(0, 2))]).toEqual([0, 1]);
    await expect(read(2, 4)).rejects.toThrow('64 MiB');
    // 只发两次 Range 请求，不下载超限整包。
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('rejects a declared oversized whole body and cancels it before reading', async () => {
    const cancel = vi.fn(async () => undefined);
    const arrayBuffer = vi.fn();
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true, headers: new Headers({ 'Content-Length': String(65 * 1024 * 1024) }),
      body: { cancel }, arrayBuffer,
    })));
    const read = createResilientReader('asset://large.mp4', null, false);
    await expect(read.getSize()).rejects.toThrow('64 MiB');
    expect(cancel).toHaveBeenCalledOnce();
    expect(arrayBuffer).not.toHaveBeenCalled();
  });

  it('stops whole-file streams at the actual limit even when Content-Length lies', async () => {
    const chunk = new Uint8Array(1024 * 1024);
    const cancel = vi.fn(async () => undefined);
    const readChunk = vi.fn(async () => ({ done: false, value: chunk }));
    const arrayBuffer = vi.fn();
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true, headers: new Headers({ 'Content-Length': '1' }),
      body: { getReader: () => ({ read: readChunk, cancel, releaseLock: vi.fn() }) }, arrayBuffer,
    })));
    const read = createResilientReader('asset://large.mp4', null, false);
    await expect(read.getSize()).rejects.toThrow('64 MiB');
    expect(readChunk).toHaveBeenCalledTimes(65);
    expect(cancel).toHaveBeenCalledOnce();
    expect(arrayBuffer).not.toHaveBeenCalled();
    // 失败后释放已预留的 64 MiB，后续两个下载仍能分别预留 64 MiB。
    vi.stubGlobal('fetch', vi.fn((_url: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
    })));
    const other = [1, 2].map(() => createResilientReader('asset://next.mp4', 64 * 1024 * 1024, false));
    const pending = other.map((reader) => reader.getSize().catch((error: unknown) => error));
    expect(fetch).toHaveBeenCalledTimes(2);
    other.forEach((reader) => reader.dispose());
    await Promise.all(pending);
  });

  it('does not use unbounded arrayBuffer when whole-file streaming is unavailable', async () => {
    const arrayBuffer = vi.fn();
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true, headers: new Headers({ 'Content-Length': '1' }), arrayBuffer,
    })));
    await expect(createResilientReader('asset://video.mp4', null, false).getSize()).rejects.toThrow('无法流式');
    expect(arrayBuffer).not.toHaveBeenCalled();
  });

  it('shares one whole download between concurrent reads', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 200 }))
      .mockResolvedValueOnce(new Response(null, { status: 200 }))
      .mockResolvedValueOnce(wholeResponse());
    vi.stubGlobal('fetch', fetchMock);
    const read = createResilientReader('asset://video.mp4', WHOLE.length);
    expect(await Promise.all([read(0, 2), read(2, 4)])).toEqual([WHOLE.slice(0, 2), WHOLE.slice(2, 4)]);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('reserves the shared budget before download and frees it exactly once on dispose', async () => {
    const fetchMock = vi.fn((_url: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
    }));
    vi.stubGlobal('fetch', fetchMock);
    const first = createResilientReader('asset://first.mp4', 64 * 1024 * 1024, false);
    const second = createResilientReader('asset://second.mp4', 64 * 1024 * 1024, false);
    const third = createResilientReader('asset://third.mp4', 64 * 1024 * 1024, false);
    const pending = [first, second].map((reader) => reader.getSize().catch((error: unknown) => error));
    await expect(third.getSize()).rejects.toThrow('128 MiB');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    first.dispose(); first.dispose();
    await pending[0];
    const replacement = createResilientReader('asset://replacement.mp4', 64 * 1024 * 1024, false);
    const replacing = replacement.getSize().catch((error: unknown) => error);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    const excess = createResilientReader('asset://excess.mp4', 1, false);
    await expect(excess.getSize()).rejects.toThrow('128 MiB');
    second.dispose(); replacement.dispose();
    await Promise.all([...pending, replacing]);
  });

  it('does not retry or fall back after an AbortError', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new DOMException('aborted', 'AbortError'));
    vi.stubGlobal('fetch', fetchMock);
    await expect(createResilientReader('asset://video.mp4', WHOLE.length)(0, 2)).rejects.toThrow('aborted');
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});

describe('createVideoInput range probe', () => {
  it('cancels an ignored probe body before starting the single whole-file download', async () => {
    const cancel = vi.fn(async () => undefined);
    const probeResponse = {
      ok: true,
      status: 200,
      headers: new Headers({ 'Content-Length': String(WHOLE.length) }),
      body: { cancel },
    } as unknown as Response;
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(probeResponse)
      .mockResolvedValueOnce(wholeResponse());
    vi.stubGlobal('fetch', fetchMock);

    const input = await createVideoInput('https://example.test/video.mp4');
    inputs.push(input);
    expect(fetchMock).not.toHaveBeenCalled();
    // 这组字节不是有效视频；格式探测仍会触发真实 CustomSource 读取。
    await input.getFormat().catch(() => undefined);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    input.dispose();
  });

  it('disposes an in-flight lazy probe without retrying or downloading the whole file', async () => {
    let signal: AbortSignal | undefined;
    const fetchMock = vi.fn((_url: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      signal = init?.signal ?? undefined;
      signal?.addEventListener('abort', () => reject(signal?.reason), { once: true });
    }));
    vi.stubGlobal('fetch', fetchMock);
    const input = await createVideoInput('asset://video.mp4');
    inputs.push(input);
    const pending = input.getFormat();
    const rejected = expect(pending).rejects.toThrow();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    input.dispose();
    await rejected;
    expect(signal?.aborted).toBe(true);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('disposes an in-flight whole-file stream after probing', async () => {
    let endRead: ((value: ReadableStreamReadResult<Uint8Array>) => void) | undefined;
    const cancel = vi.fn(async () => { endRead?.({ done: true, value: undefined }); });
    const readChunk = vi.fn(() => new Promise<ReadableStreamReadResult<Uint8Array>>((resolve) => { endRead = resolve; }));
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 200, headers: { 'Content-Length': '10' } }))
      .mockResolvedValueOnce({ ok: true, headers: new Headers({ 'Content-Length': '10' }),
        body: { getReader: () => ({ read: readChunk, cancel, releaseLock: vi.fn() }) } });
    vi.stubGlobal('fetch', fetchMock);
    const input = await createVideoInput('asset://video.mp4');
    inputs.push(input);
    const pending = input.getFormat();
    const rejected = expect(pending).rejects.toThrow();
    await vi.waitFor(() => expect(readChunk).toHaveBeenCalledOnce());
    input.dispose();
    await rejected;
    expect(cancel).toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
