/**
 * 编辑高级预设的参数定义、模板和多步骤节点序列，并提供即时结构校验。
 */
import { useT } from '../../../i18n';
import Select from '../../shared/Select';
import { useMemo } from 'react';
import { workflowExecution } from '../../../services/workflowExecutionService';
import { Icon } from '@iconify/react';
import type {
  ModelOption,
  PresetAdvancedConfig,
  PresetNodeType,
  PresetParameterDefinition,
  PresetParameterType,
  PresetParameterValue,
  PresetSequenceStep,
} from '../../../types';
import {
  PRESET_NODE_TYPES,
  getNodeTypeConfig,
} from '../../../types';
import { generateId } from '../../../store/store.utils';
import { useAppStore } from '../../../store/useAppStore';
import {
  PREVIOUS_RESULT_VARIABLE,
  composeStepPrompt,
  createPresetParameterValues,
  validatePresetAdvancedConfig,
} from '../../../services/presetTemplateService';
import ModelSelector from './ModelSelector';
import QualityRatioSelector from './QualityRatioSelector';

interface PresetAdvancedEditorProps {
  config: PresetAdvancedConfig;
  defaultNodeType: PresetNodeType;
  onChange: (config: PresetAdvancedConfig) => void;
}

const PARAMETER_TYPE_LABELS: Record<PresetParameterType, string> = {
  text: '单行文本',
  textarea: '多行文本',
  number: '数字',
  select: '单选',
  boolean: '开关',
};

function moveItem<T>(items: T[], from: number, to: number): T[] {
  if (to < 0 || to >= items.length || from === to) return items;
  const next = [...items];
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item);
  return next;
}

function createParameter(index: number): PresetParameterDefinition {
  return {
    id: 'parameter-' + generateId(),
    key: 'param_' + (index + 1),
    label: '参数 ' + (index + 1),
    type: 'text',
    required: false,
    defaultValue: '',
  };
}

function createStep(nodeType: PresetNodeType, index: number): PresetSequenceStep {
  return {
    id: 'step-' + generateId(),
    name: '步骤 ' + (index + 1),
    nodeType,
    promptTemplate: '{{currentPrompt}}',
  };
}

function ParameterDefaultEditor({
  parameter,
  onChange,
}: {
  parameter: PresetParameterDefinition;
  onChange: (value: PresetParameterValue) => void;
}) {
  const t = useT();
  if (parameter.type === 'boolean') {
    return (
      <label className="preset-advanced-checkbox">
        <input
          type="checkbox"
          checked={Boolean(parameter.defaultValue)}
          onChange={(event) => onChange(event.target.checked)}
        />
        <span>{t('默认开启')}</span>
      </label>
    );
  }

  if (parameter.type === 'select') {
    const options = parameter.options ?? [];
    return (
      <Select fixedMenu
        className="min-w-0"
        value={String(parameter.defaultValue ?? '')}
        onChange={(selectedOptionValue) => onChange(selectedOptionValue)}
      >
        <option value="">{t('无默认值')}</option>
        {options.filter(Boolean).map((option) => (
          <option key={option} value={option}>{option}</option>
        ))}
      </Select>
    );
  }

  return (
    <input
      className="preset-manager-input preset-advanced-compact-input"
      type={parameter.type === 'number' ? 'number' : 'text'}
      placeholder={t('默认值')}
      value={String(parameter.defaultValue ?? '')}
      onChange={(event) => onChange(event.target.value)}
    />
  );
}

export default function PresetAdvancedEditor({
  config,
  defaultNodeType,
  onChange,
}: PresetAdvancedEditorProps) {
  const t = useT();
  const workflows = useAppStore((state) => state.workflows);
  const errors = useMemo(() => validatePresetAdvancedConfig(config, t), [config, t]);
  // 预览用默认值渲染，未填的必填参数会显示成空——只是让变量拼写和拼接位置可见
  const previewValues = useMemo(
    () => createPresetParameterValues(config.parameters),
    [config.parameters],
  );

  const updateParameter = (id: string, patch: Partial<PresetParameterDefinition>) => {
    onChange({
      ...config,
      parameters: config.parameters.map((parameter) => (
        parameter.id === id ? { ...parameter, ...patch } : parameter
      )),
    });
  };

  const updateStep = (id: string, patch: Partial<PresetSequenceStep>) => {
    onChange({
      ...config,
      steps: config.steps.map((step) => (step.id === id ? { ...step, ...patch } : step)),
    });
  };

  const appendVariable = (step: PresetSequenceStep, key: string) => {
    const spacer = step.promptTemplate && !/\s$/.test(step.promptTemplate) ? ' ' : '';
    updateStep(step.id, { promptTemplate: step.promptTemplate + spacer + '{{' + key + '}}' });
  };

  return (
    <div className="preset-advanced-editor">
      {errors.length > 0 ? (
        <div className="preset-advanced-errors" role="status">
          <Icon icon="mdi:alert-circle-outline" width={15} height={15} />
          <ul>
            {errors.map((error) => <li key={error}>{error}</li>)}
          </ul>
        </div>
      ) : null}

      <section className="preset-advanced-section" aria-labelledby="preset-parameters-title">
        <div className="preset-advanced-section-header">
          <div>
            <h3 id="preset-parameters-title">{t('运行参数')}</h3>
            <p>{t('调用指令时填写，变量可插入任意步骤的提示词模板。')}</p>
          </div>
          <button
            type="button"
            className="preset-advanced-add-button"
            onClick={() => onChange({
              ...config,
              parameters: [...config.parameters, createParameter(config.parameters.length)],
            })}
          >
            <Icon icon="mdi:plus" width={15} height={15} />
            <span>{t('添加参数')}</span>
          </button>
        </div>

        {config.parameters.length === 0 ? (
          <div className="preset-advanced-empty">{t('没有运行参数，指令会直接显示执行确认。')}</div>
        ) : (
          <div className="preset-advanced-parameter-list">
            {config.parameters.map((parameter, index) => (
              <div className="preset-advanced-parameter-row" key={parameter.id}>
                <span className="preset-advanced-index">{index + 1}</span>
                <input
                  className="preset-manager-input"
                  value={parameter.label}
                  aria-label={t('参数 {index} 名称', { index: index + 1 })}
                  placeholder={t('显示名称')}
                  onChange={(event) => updateParameter(parameter.id, { label: event.target.value })}
                />
                <div className="preset-advanced-key-input">
                  <span>{'{{'}</span>
                  <input
                    value={parameter.key}
                    aria-label={t('参数 {index} 变量名', { index: index + 1 })}
                    onChange={(event) => updateParameter(parameter.id, { key: event.target.value.trim() })}
                  />
                  <span>{'}}'}</span>
                </div>
                <Select fixedMenu
                  className="min-w-0"
                  value={parameter.type}
                  aria-label={t('参数 {index} 类型', { index: index + 1 })}
                  onChange={(selectedOptionValue) => {
                    const type = selectedOptionValue as PresetParameterType;
                    updateParameter(parameter.id, {
                      type,
                      defaultValue: type === 'boolean' ? false : '',
                      options: type === 'select' ? ['选项 1', '选项 2'] : undefined,
                    });
                  }}
                >
                  {Object.entries(PARAMETER_TYPE_LABELS).map(([value, label]) => (
                    <option key={value} value={value}>{t(label)}</option>
                  ))}
                </Select>
                {parameter.type === 'select' ? (
                  <div className="preset-advanced-select-config">
                    <input
                      className="preset-manager-input"
                      value={(parameter.options ?? []).join('，')}
                      aria-label={t('参数 {index} 选项', { index: index + 1 })}
                      placeholder={t('选项 1，选项 2')}
                      onChange={(event) => updateParameter(parameter.id, {
                        options: event.target.value.split(/[，,]/).map((option) => option.trim()),
                      })}
                    />
                    <ParameterDefaultEditor
                      parameter={parameter}
                      onChange={(defaultValue) => updateParameter(parameter.id, { defaultValue })}
                    />
                  </div>
                ) : (
                  <ParameterDefaultEditor
                    parameter={parameter}
                    onChange={(defaultValue) => updateParameter(parameter.id, { defaultValue })}
                  />
                )}
                <label className="preset-advanced-required">
                  <input
                    type="checkbox"
                    checked={parameter.required === true}
                    onChange={(event) => updateParameter(parameter.id, { required: event.target.checked })}
                  />
                  <span>{t('必填')}</span>
                </label>
                <div className="preset-advanced-row-actions">
                  <button
                    type="button"
                    aria-label={t('上移参数')}
                    title={t('上移')}
                    disabled={index === 0}
                    onClick={() => onChange({
                      ...config,
                      parameters: moveItem(config.parameters, index, index - 1),
                    })}
                  >
                    <Icon icon="mdi:chevron-up" width={16} height={16} />
                  </button>
                  <button
                    type="button"
                    aria-label={t('下移参数')}
                    title={t('下移')}
                    disabled={index === config.parameters.length - 1}
                    onClick={() => onChange({
                      ...config,
                      parameters: moveItem(config.parameters, index, index + 1),
                    })}
                  >
                    <Icon icon="mdi:chevron-down" width={16} height={16} />
                  </button>
                  <button
                    type="button"
                    aria-label={t('删除参数')}
                    title={t('删除')}
                    onClick={() => onChange({
                      ...config,
                      parameters: config.parameters.filter((item) => item.id !== parameter.id),
                    })}
                  >
                    <Icon icon="mdi:trash-can-outline" width={15} height={15} />
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="preset-advanced-section" aria-labelledby="preset-steps-title">
        <div className="preset-advanced-section-header">
          <div>
            <h3 id="preset-steps-title">{t('顺序步骤')}</h3>
            <p>{t('第一步引用当前节点，后续步骤自动引用前一步生成结果。')}</p>
          </div>
          <button
            type="button"
            className="preset-advanced-add-button"
            onClick={() => onChange({
              ...config,
              steps: [
                ...config.steps,
                createStep(config.steps.at(-1)?.nodeType ?? defaultNodeType, config.steps.length),
              ],
            })}
          >
            <Icon icon="mdi:plus" width={15} height={15} />
            <span>{t('添加步骤')}</span>
          </button>
        </div>

        {config.steps.length === 0 ? (
          <div className="preset-advanced-empty">{t('添加至少一个生成步骤后才能保存高级指令。')}</div>
        ) : (
          <div className="preset-advanced-step-list">
            {config.steps.map((step, index) => {
              const visual = getNodeTypeConfig(step.nodeType);
              return (
                <article className="preset-advanced-step" key={step.id}>
                  <header className="preset-advanced-step-header">
                    <span className={'preset-advanced-step-icon ' + visual.bg + ' ' + visual.color}>
                      <Icon icon={visual.icon} width={16} height={16} />
                    </span>
                    <span className="preset-advanced-step-number">{index + 1}</span>
                    <input
                      className="preset-advanced-step-name"
                      value={step.name}
                      aria-label={t('步骤 {index} 名称', { index: index + 1 })}
                      placeholder={t('步骤名称')}
                      onChange={(event) => updateStep(step.id, { name: event.target.value })}
                    />
                    <Select fixedMenu
                      className="min-w-0"
                      value={step.nodeType}
                      aria-label={t('步骤 {index} 节点类型', { index: index + 1 })}
                      onChange={(selectedOptionValue) => updateStep(step.id, {
                        nodeType: selectedOptionValue as PresetNodeType,
                        model: undefined,
                        provider: undefined,
                        workflowId: undefined,
                        imageSize: undefined,
                        aspectRatio: undefined,
                      })}
                    >
                      {PRESET_NODE_TYPES.map((nodeType) => (
                        <option key={nodeType} value={nodeType}>
                          {t(getNodeTypeConfig(nodeType).label)}
                        </option>
                      ))}
                    </Select>
                    <div className="preset-advanced-row-actions">
                      <button
                        type="button"
                        aria-label={t('上移步骤')}
                        title={t('上移')}
                        disabled={index === 0}
                        onClick={() => onChange({
                          ...config,
                          steps: moveItem(config.steps, index, index - 1),
                        })}
                      >
                        <Icon icon="mdi:chevron-up" width={16} height={16} />
                      </button>
                      <button
                        type="button"
                        aria-label={t('下移步骤')}
                        title={t('下移')}
                        disabled={index === config.steps.length - 1}
                        onClick={() => onChange({
                          ...config,
                          steps: moveItem(config.steps, index, index + 1),
                        })}
                      >
                        <Icon icon="mdi:chevron-down" width={16} height={16} />
                      </button>
                      <button
                        type="button"
                        aria-label={t('删除步骤')}
                        title={t('删除')}
                        onClick={() => onChange({
                          ...config,
                          steps: config.steps.filter((item) => item.id !== step.id),
                        })}
                      >
                        <Icon icon="mdi:trash-can-outline" width={15} height={15} />
                      </button>
                    </div>
                  </header>

                  <div className="preset-advanced-variable-bar">
                    <span>{t('插入变量')}</span>
                    <button type="button" onClick={() => appendVariable(step, 'currentPrompt')}>
                      {t('当前提示词')}
                    </button>
                    <button
                      type="button"
                      onClick={() => appendVariable(step, PREVIOUS_RESULT_VARIABLE)}
                    >
                      {t(index === 0 ? '触发节点' : '上一步结果')}
                    </button>
                    {config.parameters.map((parameter) => (
                      <button
                        type="button"
                        key={parameter.id}
                        onClick={() => appendVariable(step, parameter.key)}
                      >
                        {parameter.label || parameter.key}
                      </button>
                    ))}
                  </div>
                  <textarea
                    className="preset-manager-input preset-advanced-step-template"
                    value={step.promptTemplate}
                    aria-label={t('步骤 {index} 提示词模板', { index: index + 1 })}
                    placeholder={t('输入此步骤的提示词模板')}
                    onChange={(event) => updateStep(step.id, { promptTemplate: event.target.value })}
                  />

                  <div className="preset-advanced-step-preview">
                    <span>{t('预览')}</span>
                    <p>
                      {composeStepPrompt(
                        step.promptTemplate,
                        previewValues,
                        t('当前提示词'),
                        t(index === 0 ? '@触发节点' : '@上一步'),
                      )}
                    </p>
                  </div>

                  <div className="preset-advanced-step-settings">
                    <div className="preset-advanced-setting">
                      <span>{t('模型')}</span>
                      <ModelSelector
                        nodeType={step.nodeType}
                        selectedModel={step.model}
                        selectedProvider={step.provider}
                        selectedWorkflowId={step.workflowId}
                        workflows={workflows}
                        onSelect={(model: ModelOption) => updateStep(step.id, {
                          model: model.value,
                          provider: model.provider,
                          workflowId: undefined,
                        })}
                        onWorkflowSelect={(workflowId) => {
                          const workflow = workflows.find((item) => item.id === workflowId);
                          updateStep(step.id, workflow ? workflowExecution(workflow) : { workflowId: undefined });
                        }}
                      />
                      {step.model || step.workflowId ? (
                        <button
                          type="button"
                          className="preset-advanced-clear-button"
                          onClick={() => updateStep(step.id, {
                            model: undefined,
                            provider: undefined,
                            workflowId: undefined,
                          })}
                        >
                          {t('使用默认')}
                        </button>
                      ) : null}
                    </div>
                    {step.nodeType === 'ai-image' ? (
                      <div className="preset-advanced-setting">
                        <span>{t('尺寸')}</span>
                        <QualityRatioSelector
                          imageSize={step.imageSize}
                          aspectRatio={step.aspectRatio}
                          onChangeImageSize={(imageSize) => updateStep(step.id, { imageSize })}
                          onChangeAspectRatio={(aspectRatio) => updateStep(step.id, { aspectRatio })}
                          placement="bottom"
                          showImageSize
                        />
                      </div>
                    ) : null}
                  </div>
                </article>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}
