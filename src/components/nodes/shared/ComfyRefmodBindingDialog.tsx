import { useState } from 'react';
import type { ComfyRefmodAsset, ComfyRefmodBindingRequest, ComfyRefmodSelection } from '../../../types/comfyRefmod';
import { useComfyRefmodMentionOptions } from '../../../hooks/useComfyRefmodMentionOptions';
import { comfyRefmodKey } from '../../../utils/comfyRefmod';
import { useAppStore } from '../../../store/useAppStore';
import ComfyRefmodMentionSettings from './ComfyRefmodMentionSettings';

/** 多份参考包逐一明确槽位，全部确认后才交给原写入服务统一 fresh 校验。 */
export default function ComfyRefmodBindingDialog({ request, onApply, onClose }: {
  request: ComfyRefmodBindingRequest;
  onApply: (items: ComfyRefmodSelection[]) => void;
  onClose: () => void;
}) {
  const [mapped, setMapped] = useState<ComfyRefmodSelection[]>([]);
  const options = useComfyRefmodMentionOptions({ enabled: true, workflow: request.workflow });
  const saved = useAppStore((state) => state.config.comfyRefmodAssets);
  const incoming = request.incoming[mapped.length];
  const asset: ComfyRefmodAsset = saved?.find((item) => comfyRefmodKey(item) === comfyRefmodKey(incoming))
    ?? { ...incoming, id: comfyRefmodKey(incoming), name: incoming.fileName, tags: [], updatedAt: 0 };
  return <ComfyRefmodMentionSettings key={`${mapped.length}:${options.catalog?.fetchedAt ?? 'loading'}`} workflow={request.workflow} asset={asset} bindingMode stepLabel={`第 ${mapped.length + 1} / ${request.incoming.length} 个参考包`}
    catalog={options.catalog} loading={options.loading} error={options.error} refresh={options.refresh}
    existing={[...request.existing, ...mapped]} manual={request.existing} onClose={onClose}
    onApply={async (selection) => {
      const next = [...mapped, selection];
      if (next.length === request.incoming.length) onApply(next);
      else setMapped(next);
    }} />;
}
