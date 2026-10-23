import { beforeEach, describe, expect, it, vi } from 'vitest';

const driver = vi.hoisted(() => ({ open: false }));
vi.mock('react', async () => ({
  ...await vi.importActual<typeof import('react')>('react'),
  useState: () => [driver.open, (open: boolean) => { driver.open = open; }],
  useRef: () => ({ current: null }),
  useEffect: () => undefined,
}));
vi.mock('../../src/i18n', () => ({ useT: () => (text: string) => text }));
import QualityRatioSelector from '../../src/components/nodes/shared/QualityRatioSelector';

interface ElementLike { props: Record<string, unknown> & { children?: unknown } }
function elements(tree: unknown): ElementLike[] {
  if (Array.isArray(tree)) return tree.flatMap(elements);
  if (!tree || typeof tree !== 'object' || !('props' in tree)) return [];
  const element = tree as ElementLike;
  return [element, ...elements(element.props.children)];
}
function render(props: Partial<Parameters<typeof QualityRatioSelector>[0]> = {}) {
  return elements(QualityRatioSelector({ imageSize: '2K', aspectRatio: '16:9', onChangeAspectRatio: vi.fn(), ...props }));
}
function summary(tree: ElementLike[]) {
  return tree.find((element) => element.props['data-ui-schema-menu-trigger'] === 'qualityRatio')!.props;
}
function qualityOptions(tree: ElementLike[]) {
  return tree.find((element) => element.props['data-ui-schema-field'] === 'imageQuality');
}
beforeEach(() => { driver.open = false; });

describe('image resolution and quality selector', () => {
  it('retains the shared size/ratio pill and omits undeclared generation quality', () => {
    driver.open = true;
    const tree = render({ imageQuality: 'max' });
    expect(summary(tree)['aria-label']).toBe('16:9 · 2K');
    expect(qualityOptions(tree)).toBeUndefined();
    expect(tree.some((element) => element.props.children === '分辨率')).toBe(true);
  });

  it('renders only declared raw quality values and changes quality independently', () => {
    driver.open = true;
    const onChangeImageQuality = vi.fn();
    const onChangeImageSize = vi.fn();
    const values = ['auto', 'low', 'medium', 'high', 'xhigh', 'max'];
    const tree = render({ imageQualities: values, imageQuality: 'high', onChangeImageQuality, onChangeImageSize });
    const options = elements(qualityOptions(tree)).filter((element) => 'data-ui-schema-value' in element.props);
    expect(options.map((element) => element.props.children)).toEqual(values);
    expect(options.filter((element) => element.props['aria-pressed']).map((element) => element.props.children)).toEqual(['high']);
    (options.at(-1)!.props.onClick as () => void)();
    expect(onChangeImageQuality).toHaveBeenCalledWith('max');
    expect(onChangeImageSize).not.toHaveBeenCalled();
    expect(summary(tree).title).toBe('16:9 · 2K · high');
  });

  it('uses a declared default and hides stale quality after a model capability changes', () => {
    driver.open = true;
    const tree = render({ imageQuality: 'max', imageQualities: ['low', 'medium', 'high'], defaultImageQuality: 'medium' });
    expect(summary(tree)['aria-label']).toBe('16:9 · 2K · medium');
    const options = elements(qualityOptions(tree)).filter((element) => 'data-ui-schema-value' in element.props);
    expect(options.filter((element) => element.props['aria-pressed']).map((element) => element.props.children)).toEqual(['medium']);
    expect(options.some((element) => element.props.children === 'max')).toBe(false);
  });

  it('does not invent auto or a first-option default for a model with no declared default', () => {
    driver.open = true;
    const tree = render({ imageQualities: ['low', 'medium', 'high'] });
    expect(summary(tree)['aria-label']).toBe('16:9 · 2K');
    const options = elements(qualityOptions(tree)).filter((element) => 'data-ui-schema-value' in element.props);
    expect(options.some((element) => element.props['aria-pressed'])).toBe(false);
    expect(options.some((element) => element.props.children === 'auto')).toBe(false);
  });

  it('shows a fixed provider quality as a single declared choice', () => {
    driver.open = true;
    const tree = render({ imageQualities: ['high'], defaultImageQuality: 'high', showImageSize: false });
    expect(summary(tree)['aria-label']).toBe('16:9 · high');
    const options = elements(qualityOptions(tree)).filter((element) => 'data-ui-schema-value' in element.props);
    expect(options.map((element) => element.props.children)).toEqual(['high']);
    expect(options[0].props['aria-pressed']).toBe(true);
  });

  it('displays the canonical spelling for a case-insensitive saved quality', () => {
    driver.open = true;
    const tree = render({ imageQualities: ['low', 'high'], imageQuality: 'HIGH' });
    expect(summary(tree)['aria-label']).toBe('16:9 · 2K · high');
    const options = elements(qualityOptions(tree)).filter((element) => 'data-ui-schema-value' in element.props);
    expect(options.filter((element) => element.props['aria-pressed']).map((element) => element.props.children)).toEqual(['high']);
  });
});
