import { useEffect, type RefObject } from 'react';
import { bindComfyDomImageSources } from '../services/comfyDomImageSource';

export function useComfyDomImageSources(rootRef: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    const root = rootRef.current;
    if (root) return bindComfyDomImageSources(root);
  }, [rootRef]);
}
