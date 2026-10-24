/**
 * en-US 词条聚合：key 是源码里的中文原文，缺失时自动回落中文。
 * 按功能域拆分到各模块文件，新增模块在此处汇总。
 */
import common from './common';
import settings from './settings';
import onboarding from './onboarding';
import project from './project';
import character from './character';
import canvas from './canvas';
import chat from './chat';
import nodes from './nodes';
import series from './series';
import projectSettings from './projectSettings';
import videoEditor from './videoEditor';
import comfyui from './comfyui';
import help from './help';
import workflow from './workflow';
import director from './director';
import assets from './assets';
import imageEditor from './imageEditor';
import volcengine from './volcengine';
import assetManagement from './assetManagement';

const enUS: Record<string, string> = {
  ...common,
  ...settings,
  ...onboarding,
  ...project,
  ...character,
  ...canvas,
  ...chat,
  ...nodes,
  ...series,
  ...projectSettings,
  ...videoEditor,
  ...comfyui,
  ...help,
  ...workflow,
  ...director,
  ...assets,
  ...imageEditor,
  ...volcengine,
  ...assetManagement,
};

export default enUS;
