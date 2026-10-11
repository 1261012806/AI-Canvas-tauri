import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ImageCapabilityEditor from '../../src/components/settings/providerConnection/ImageCapabilityEditor';

describe('image capability editor', () => {
  it('keeps missing capabilities undeclared instead of selecting preset tiers', () => {
    const html = renderToStaticMarkup(createElement(ImageCapabilityEditor, {
      model: { id: 'custom-image', name: 'Custom Image', category: 'image', provider: 'custom' },
      onChange: () => undefined, onClose: () => undefined,
    }));
    expect(html).toContain('图片参数能力');
    expect(html).toContain('待确认');
    expect(html).not.toContain('aria-pressed="true"');
  });
});
