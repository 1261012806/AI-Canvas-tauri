import { useCallback, useEffect, useRef, useState } from 'react';
import DramaAssetImportDialog from '../components/assets/DramaAssetImportDialog';
import type { DramaAssetIdentity, DramaAssetImportPreview } from '../services/dramaAssetTransferFormat';
import type { DramaAssetTransferOptions } from '../services/dramaAssetTransferService';

/** A view owns the pending choice; closing it or cancelling the transfer settles the promise. */
export function useDramaAssetImportDialog() {
  const [request, setRequest] = useState<{ key: number; preview: DramaAssetImportPreview } | null>(null);
  const sequence = useRef(0);
  const mounted = useRef(true);
  const pending = useRef<{ key: number; resolve: (assets: readonly DramaAssetIdentity[] | null) => void; cleanup: () => void } | null>(null);
  const finish = useCallback((assets: readonly DramaAssetIdentity[] | null, key?: number) => {
    const current = pending.current;
    if (!current || (key !== undefined && current.key !== key)) return;
    pending.current = null;
    current.cleanup();
    setRequest(null);
    current.resolve(assets);
  }, []);
  const chooseAssets: NonNullable<DramaAssetTransferOptions['chooseAssets']> = useCallback((preview: DramaAssetImportPreview, signal?: AbortSignal) => new Promise<readonly DramaAssetIdentity[] | null>((resolve) => {
    if (!mounted.current || signal?.aborted || pending.current) { resolve(null); return; }
    const key = ++sequence.current;
    const abort = () => finish(null, key);
    pending.current = { key, resolve, cleanup: () => signal?.removeEventListener('abort', abort) };
    signal?.addEventListener('abort', abort, { once: true });
    setRequest({ key, preview });
    if (signal?.aborted) finish(null, key);
  }), [finish]);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      const current = pending.current;
      pending.current = null;
      current?.cleanup();
      current?.resolve(null);
    };
  }, []);
  return { chooseAssets,
    dialog: request ? <DramaAssetImportDialog key={request.key} preview={request.preview} onChoose={(assets) => finish(assets, request.key)} /> : null,
  };
}
