import { describe, expect, it } from 'vitest';
import { resolveVideoThumbnailPoster } from '../../src/components/shared/videoThumbnailSource';

describe('静态视频封面来源', () => {
  it.each([
    'https://media.example/final.mp4',
    'https://media.example/final.WEBM?token=private#frame',
    'asset://localhost/D%3A%2Fmedia%2Ffinal%2Emp4?revision=2',
    'data:video/mp4;base64,AQID',
    'data:audio/wav;base64,AQID',
  ])('不将视频或音频地址挂到 img：%s', (poster) => {
    expect(resolveVideoThumbnailPoster(poster)).toBeUndefined();
  });

  it('拒绝无扩展名原视频和同一本地视频的 URL 别名', () => {
    const src = 'https://media.example/stream?token=private';
    expect(resolveVideoThumbnailPoster(src, src)).toBeUndefined();
    expect(resolveVideoThumbnailPoster('asset://localhost/D%3A%2Fmedia%2Fstream', 'file:///d:/media/stream')).toBeUndefined();
    expect(resolveVideoThumbnailPoster('asset://localhost/D%3A%2Fmedia%2Fstream', undefined, 'd:/media/stream')).toBeUndefined();
  });

  it.each(['https://media.example/cover.jpg?revision=2', 'data:image/png;base64,AQID'])('保留明确图片封面与旧同源图片快照：%s', (poster) => {
    expect(resolveVideoThumbnailPoster(poster, 'https://media.example/final.mp4')).toBe(poster);
    expect(resolveVideoThumbnailPoster(poster, poster)).toBe(poster);
  });

  it('未知 blob 仅在不同于视频源时作为候选，由图片加载失败回退缓存', () => {
    expect(resolveVideoThumbnailPoster('blob:poster', 'blob:video')).toBe('blob:poster');
    expect(resolveVideoThumbnailPoster('blob:video', 'blob:video')).toBeUndefined();
  });
});
