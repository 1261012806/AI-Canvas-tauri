import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { AppearanceCanvasConfig } from '../../src/types';
import CanvasImageBackground from '../../src/components/backgrounds/CanvasImageBackground';

const imageDataUrl = 'data:image/png;base64,AA==';
const baseColor = '#213547';

function render(canvas: Partial<AppearanceCanvasConfig>) {
  const markup = renderToStaticMarkup(<CanvasImageBackground canvas={canvas} baseColor={baseColor} />);
  return { markup, layers: markup.match(/<span\b[^>]*>/g) ?? [] };
}

describe('canvas image background layers', () => {
  it('keeps image filters and opacity separate from the base color and overlay', () => {
    const { markup, layers } = render({
      imageDataUrl, imageOpacity: 0.4, imageBlur: 12,
      imageBrightness: 0.8, imageContrast: 1.2, imageSaturation: 0.5,
      imageOverlayColor: '#351b49', imageOverlayOpacity: 0.65,
    });

    expect(layers).toHaveLength(3);
    const [base, image, overlay] = layers;
    expect(base).toContain(`background-color:${baseColor}`);
    expect(base).not.toContain('filter:');
    expect(base).not.toContain('opacity:');
    expect(image).toContain(`background-image:url(&quot;${imageDataUrl}&quot;)`);
    expect(image).toContain('opacity:0.4');
    expect(image).toContain('filter:blur(12px) brightness(0.8) contrast(1.2) saturate(0.5)');
    expect(overlay).toContain('background-color:#351b49');
    expect(overlay).toContain('opacity:0.65');
    expect(overlay).not.toContain('filter:');
    // The overlay is the image layer's sibling, so it cannot inherit its filter or opacity.
    expect(markup).toContain(`</span>${overlay}`);
    expect(base).toContain('pointer-events-none');
    expect(base).toContain('overflow-hidden');
  });

  it.each([
    {},
    { imageBlur: 0, imageBrightness: 1, imageContrast: 1, imageSaturation: 1, imageOverlayOpacity: 0, imageOpacity: 1 },
  ])('uses neutral filters and no overlay for default adjustments: %j', (adjustments) => {
    const { layers } = render({ imageDataUrl, ...adjustments });
    expect(layers).toHaveLength(2);
    expect(layers[1]).toContain('opacity:1');
    expect(layers[1]).toContain('background-size:cover');
    expect(layers[1]).toContain('background-position:center');
    expect(layers[1]).not.toContain('filter:');
  });

  it('preserves zero-valued adjustments while leaving the independent overlay visible', () => {
    const { layers } = render({
      imageDataUrl, imageOpacity: 0, imageBlur: 0,
      imageBrightness: 0, imageContrast: 0, imageSaturation: 0,
      imageOverlayColor: '#584722', imageOverlayOpacity: 0.6,
    });
    expect(layers).toHaveLength(3);
    expect(layers[0]).toContain(`background-color:${baseColor}`);
    expect(layers[1]).toContain('opacity:0;');
    expect(layers[1]).toContain('filter:blur(0px) brightness(0) contrast(0) saturate(0)');
    expect(layers[2]).toContain('opacity:0.6');
  });

  it('keeps the base color without image or overlay layers when no image is selected', () => {
    const { markup, layers } = render({ imageBlur: 15, imageOverlayColor: '#351b49', imageOverlayOpacity: 1 });
    expect(layers).toHaveLength(1);
    expect(layers[0]).toContain(`background-color:${baseColor}`);
    expect(markup).not.toContain('background-image:');
    expect(markup).not.toContain('filter:');
    expect(markup).not.toContain('#351b49');
  });

  it.each([
    ['cover', 'cover'],
    ['contain', 'contain'],
    ['fill', '100% 100%'],
  ] as const)('maps %s fit and preserves the selected image position', (imageFit, backgroundSize) => {
    const { layers } = render({ imageDataUrl, imageFit, imagePosition: 'right bottom' });
    expect(layers[1]).toContain(`background-size:${backgroundSize}`);
    expect(layers[1]).toContain('background-position:right bottom');
  });
});
