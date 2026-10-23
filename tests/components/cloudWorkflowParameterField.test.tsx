import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import CloudWorkflowParameterField from '../../src/components/nodes/shared/CloudWorkflowParameterField';

const ignoreChange = () => undefined;

describe('云工作流参数默认展示', () => {
  it('时长只显示滑块和默认值，不再提供数值输入或区间编辑', () => {
    const html = renderToStaticMarkup(<CloudWorkflowParameterField name="duration" label="时长" type="number"
      value="" defaultValue={12} min={4} max={30} displayDefaultWhenEmpty onChange={ignoreChange} />);
    const sliderInput = html.match(/<input[^>]*type="range"[^>]*>/)?.[0] ?? '';
    expect(html).not.toContain('type="number"');
    expect(html).not.toContain('调整滑块区间');
    expect(sliderInput).toContain('value="12"');
    expect(sliderInput).not.toContain('disabled=""');
  });

  it('声明式文本默认值不妨碍清空后重新输入', () => {
    const html = renderToStaticMarkup(<CloudWorkflowParameterField name="scheduler" label="调度器" type="string"
      value="" defaultValue="simple" displayDefaultWhenEmpty onChange={ignoreChange} />);
    expect(html).toContain('placeholder="simple"');
    expect(html).toContain('value=""');
    expect(html).not.toContain('value="simple"');
  });

  it('声明式枚举默认 0 和 false 保持选中态', () => {
    const zero = renderToStaticMarkup(<CloudWorkflowParameterField name="seed" label="种子" type="number"
      value="" defaultValue={0} options={[0, 1]} displayDefaultWhenEmpty onChange={ignoreChange} />);
    const falseValue = renderToStaticMarkup(<CloudWorkflowParameterField name="enabled" label="声音" type="boolean"
      value="" defaultValue={false} displayDefaultWhenEmpty onChange={ignoreChange} />);
    expect(zero).toContain('title="0" aria-pressed="true"');
    expect(falseValue).toContain('title="false" aria-pressed="true"');
  });

  it('RunningHub 显式空串不会被默认值重新选中', () => {
    const html = renderToStaticMarkup(<CloudWorkflowParameterField name="duration" label="时长" type="number"
      value="" defaultValue={12} min={4} max={30} onChange={ignoreChange} />);
    const sliderInput = html.match(/<input[^>]*type="range"[^>]*>/)?.[0] ?? '';
    expect(sliderInput).toContain('disabled=""');
    expect(sliderInput).not.toContain('value="12"');
    expect(html).toContain('未填写；请选择刻度设置。');
  });

  it('合法的非步长倍数保留精确值，不让滑块自动显示为相邻值', () => {
    const html = renderToStaticMarkup(<CloudWorkflowParameterField name="resolution" label="分辨率" type="number"
      value="1.6" min={1} max={2} step={0.5} onChange={ignoreChange} />);
    const sliderInput = html.match(/<input[^>]*type="range"[^>]*>/)?.[0] ?? '';
    expect(sliderInput).toContain('value="1.6"');
    expect(sliderInput).toContain('step="any"');
    expect(sliderInput).toContain('disabled=""');
    expect(html).toContain('原值保留；选择刻度后可拖动调整');
  });

  it('数值型分辨率使用固定端点，普通数字字段仍可输入', () => {
    const resolution = renderToStaticMarkup(<CloudWorkflowParameterField name="resolution" label="分辨率" type="number"
      value="1.5" onChange={ignoreChange} />);
    const sliderInput = resolution.match(/<input[^>]*type="range"[^>]*>/)?.[0] ?? '';
    expect(sliderInput).toContain('min="0.2"');
    expect(sliderInput).toContain('max="4"');
    expect(resolution).not.toContain('type="number"');
    const seed = renderToStaticMarkup(<CloudWorkflowParameterField name="seed" label="种子" type="number" value="0" onChange={ignoreChange} />);
    expect(seed).toContain('type="number"');
    expect(seed).toContain('value="0"');
  });

  it('固定范围没有默认值时仍能通过唯一刻度填写', () => {
    const html = renderToStaticMarkup(<CloudWorkflowParameterField name="duration" label="时长" type="integer"
      value="" min={2} max={2} onChange={ignoreChange} />);
    expect(html).toMatch(/<button[^>]*aria-pressed="false"[^>]*>2<\/button>/);
    expect(html).not.toContain('type="number"');
    expect(html).not.toContain('当前参数范围不可用');
  });
});
