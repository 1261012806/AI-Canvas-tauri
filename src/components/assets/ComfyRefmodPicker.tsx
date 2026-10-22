import type { ComfyRefmodLoaderType, ComfyRefmodSelection } from '../../types/comfyRefmod';
import ModalOverlay from '../shared/ModalOverlay';
import PopupCloseButton from '../shared/PopupCloseButton';
import { RefmodCatalogBrowser } from './RefModAssetsPanel';

export interface ComfyRefmodPickerProps {
  isOpen: boolean;
  serverId?: string;
  lockServer?: boolean;
  loaderType?: ComfyRefmodLoaderType;
  selectedKeys?: string[];
  maxSelections?: number;
  onClose: () => void;
  onConfirm: (items: ComfyRefmodSelection[]) => void | Promise<void>;
}

export default function ComfyRefmodPicker({ isOpen, onClose, onConfirm, ...props }: ComfyRefmodPickerProps) {
  return <ModalOverlay isOpen={isOpen} onClose={onClose} ariaLabel="选择角色参考包" className="flex h-[min(82vh,44rem)] w-[min(92vw,62rem)] flex-col" closeOnBackdrop={false} zIndex={320}>
    <div className="flex items-center justify-between border-b border-canvas-border p-3">
      <div><h2 className="ui-title">选择角色参考包</h2><p className="mt-1 text-xs text-canvas-text-muted">按服务与插件格式引用已有 RefMod 文件</p></div>
      <PopupCloseButton onClick={onClose} ariaLabel="关闭角色参考包选择器" />
    </div>
    {isOpen && <RefmodCatalogBrowser {...props} onConfirm={async (items) => { await onConfirm(items); onClose(); }} />}
  </ModalOverlay>;
}
