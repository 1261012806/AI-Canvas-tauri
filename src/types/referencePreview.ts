/** 窗口内引用预览请求；仅用于即时展示，不进入项目、历史或消息持久化。 */
export interface ReferencePreviewSource {
  kind: 'node' | 'drama' | 'asset' | 'workflow' | 'skill' | 'model' | 'chat-image';
  id: string;
  label: string;
  /** 工作流 IO 胶囊中的当前值。 */
  value?: string;
  ownerNodeId?: string;
}

/** 引用胶囊的即时悬浮信息；节点、单镜和资产库共用同一展示字段。 */
export interface MentionChipPreview {
  label: string;
  displayId?: number;
  outputType: 'image' | 'video' | 'audio' | 'text';
  thumbnailUrl?: string;
  thumbnailUrls?: string[];
  sprite?: { backgroundSize: string; backgroundPosition: string };
  text: string;
  missing: boolean;
  description?: string;
}

/** 各类引用与资源库共用大屏展示，内容由当前窗口按真实引用读取。 */
export interface ReferencePreviewContent {
  kind: 'text' | 'markdown' | 'image' | 'video' | 'audio';
  title: string;
  text?: string;
  mediaUrl?: string;
  images?: Array<{ url: string; label: string }>;
  /** 与宫格几何共用 0..100 百分比。 */
  imageCrop?: { x: number; y: number; width: number; height: number };
  description?: string;
  prompt?: string;
  details?: Array<{ label: string; value: string }>;
  unavailable?: string;
}
