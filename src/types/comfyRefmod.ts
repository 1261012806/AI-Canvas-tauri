import type { WorkflowDefinition } from './index';

/** RefMod 引用只保存服务身份和插件返回的相对文件名，不保存地址或本地路径。 */
export type ComfyRefmodLoaderType = 'minimax-h3' | 'refmods-lab' | 'h3-refmods';

export interface ComfyRefmodFileRef {
  serverId?: string;
  endpointFingerprint: string;
  loaderType: ComfyRefmodLoaderType;
  fileName: string;
}

/** 节点绑定只影响本次执行副本；未绑定的原工作流参数保持原值。 */
export interface ComfyRefmodSelection extends ComfyRefmodFileRef {
  strength: number;
  loaderNodeId?: string;
  slot?: number;
  /** 槽位与覆盖意图只对绑定时的工作流及其原文件值有效。 */
  workflowId?: string;
  originalFileName?: string;
  /** 用户在指定槽位明确选择了替换原值，拖放自动分配不得设置此项。 */
  replaceExisting?: boolean;
}

export interface ComfyRefmodAsset extends ComfyRefmodFileRef {
  id: string;
  name: string;
  tags: string[];
  description?: string;
  kind?: string;
  tokens?: number;
  updatedAt: number;
}

export interface ComfyRefmodSlotSchema {
  slot: number;
  fileField: string;
  allowedNames: string[];
  emptyNames: string[];
  strengthField?: string;
  additionalStrengthFields?: string[];
  strengthMin?: number;
  strengthMax?: number;
  strengthStep?: number;
  strengthDefault?: number;
}

export interface ComfyRefmodLoaderSchema {
  loaderType: ComfyRefmodLoaderType;
  classType: string;
  label: string;
  slots: ComfyRefmodSlotSchema[];
  description?: string;
}

export interface ComfyRefmodServerIdentity {
  serverId?: string;
  serverName: string;
  endpointFingerprint: string;
}

export interface ComfyRefmodCatalog extends ComfyRefmodServerIdentity {
  entries: ComfyRefmodAsset[];
  loaders: ComfyRefmodLoaderSchema[];
  warnings: string[];
  /** 部分读取失败时旧缓存只能标记未验证，不能误报文件缺失。 */
  failedLoaderTypes?: ComfyRefmodLoaderType[];
  fetchedAt: number;
}

/** 仅当前调用方内存中的映射请求；不进入配置或项目持久化。 */
export interface ComfyRefmodBindingRequest {
  workflow: WorkflowDefinition;
  incoming: ComfyRefmodSelection[];
  existing: ComfyRefmodSelection[];
}
export type ComfyRefmodBindingResolver = (request: ComfyRefmodBindingRequest) => Promise<ComfyRefmodSelection[]>;
