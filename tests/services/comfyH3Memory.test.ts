import { beforeEach, describe, expect, it, vi } from 'vitest';
import { comfyH3MemoryFingerprint, DEFAULT_COMFY_H3_MEMORY_SETTINGS } from '../../src/types/comfyLaunch';

const mocks = vi.hoisted(() => ({ fetch: vi.fn(), getSettings: vi.fn(), desktop: vi.fn(() => true) }));
vi.mock('../../src/services/comfyPolling', () => ({ comfyFetch: mocks.fetch }));
vi.mock('../../src/services/comfyLaunchSettingsService', () => ({ getComfyLaunchSettings: mocks.getSettings }));
vi.mock('../../src/services/fs/core', () => ({ isTauriEnv: mocks.desktop }));

import { applyComfyH3Memory, isComfyH3Workflow, resolveComfyH3MemorySettings } from '../../src/services/comfyH3Memory';

type Graph = Record<string, { class_type: string; inputs: Record<string, unknown> }>;
const field = (type: unknown, options: Record<string, unknown> = {}) => [type, options];
const spec = (required: Record<string, unknown>, output: string[], optional: Record<string, unknown> = {}) => ({ input: { required, optional }, output });

function schemas() {
  return {
    UNETLoader: spec({ unet_name: field('STRING') }, ['MODEL']),
    CLIPLoader: spec({ clip_name: field('STRING'), type: field(['minimax', 'other']), device: field(['default', 'cpu']) }, ['CLIP']),
    VAELoader: spec({ vae_name: field('STRING') }, ['VAE']),
    LoadImage: spec({ image: field('STRING') }, ['IMAGE', 'MASK']),
    MiniMaxH3ReferenceToVideo: spec({ clip: field('CLIP'), width: field('INT'), height: field('INT'), length: field('INT') }, ['CONDITIONING', 'LATENT'], {
      vae: field('VAE'), audio_vae: field('VAE'),
      ref_images: field('COMFY_AUTOGROW_V3', { template: { prefix: 'ref_image_', max: 9, input: { required: { ref_image: field('IMAGE') } } } }),
      'ref_videos.ref_video_0': field('IMAGE'),
    }),
    BasicGuider: spec({ model: field('MODEL'), conditioning: field('CONDITIONING') }, ['GUIDER']),
    SamplerCustomAdvanced: spec({ guider: field('GUIDER'), latent_image: field('LATENT') }, ['LATENT', 'LATENT']),
    LTXVSeparateAVLatent: spec({ av_latent: field('LATENT') }, ['LATENT', 'LATENT']),
    VAEDecode: spec({ samples: field('LATENT'), vae: field('VAE') }, ['IMAGE']),
    VAEDecodeAudio: spec({ samples: field('LATENT'), vae: field('VAE') }, ['AUDIO']),
    VAEDecodeTiled: spec({ samples: field('LATENT'), vae: field('VAE'),
      tile_size: field('INT', { min: 64, max: 4096, step: 64 }), overlap: field('INT', { min: 0, max: 4096, step: 32 }),
      temporal_size: field('INT', { min: 8, max: 4096, step: 4 }), temporal_overlap: field('INT', { min: 4, max: 4096, step: 4 }),
    }, ['IMAGE']),
    MiniMaxLowVRAMAttention: spec({ model: field('MODEL'), head_chunks: field('INT', { min: 1, max: 56, step: 1 }) }, ['MODEL']),
    MiniMaxChunkFeedForward: spec({ model: field('MODEL'), chunks: field('INT', { min: 1, max: 64, step: 1 }),
      seq_threshold: field('INT', { min: 256, max: 262144, step: 256 }),
    }, ['MODEL']),
    'ImageResize+': spec({ image: field('IMAGE'), width: field('INT', { min: 0, max: 16384, step: 1 }), height: field('INT', { min: 0, max: 16384, step: 1 }),
      interpolation: field(['lanczos']), method: field(['keep proportion']), condition: field(['always', 'downscale if bigger']),
      multiple_of: field('INT', { min: 0, max: 512, step: 1 }),
    }, ['IMAGE', 'INT', 'INT']),
  };
}

function workflow(): Graph {
  return {
    model: { class_type: 'UNETLoader', inputs: { unet_name: 'minimax_h3_ref2va_int8.safetensors' } },
    clip: { class_type: 'CLIPLoader', inputs: { clip_name: 'original_encoder.safetensors', type: 'minimax', device: 'default' } },
    vae: { class_type: 'VAELoader', inputs: { vae_name: 'original_video_vae.safetensors' } },
    audioVae: { class_type: 'VAELoader', inputs: { vae_name: 'original_audio_vae.safetensors' } },
    image: { class_type: 'LoadImage', inputs: { image: 'original/character.png' } },
    referenceVideo: { class_type: 'LoadImage', inputs: { image: 'original/reference_frames.png' } },
    condition: { class_type: 'MiniMaxH3ReferenceToVideo', inputs: { clip: ['clip', 0], vae: ['vae', 0], audio_vae: ['audioVae', 0],
      width: 1344, height: 768, length: 362, 'ref_images.ref_image_0': ['image', 0], 'ref_videos.ref_video_0': ['referenceVideo', 0],
    } },
    guider: { class_type: 'BasicGuider', inputs: { model: ['model', 0], conditioning: ['condition', 0] } },
    sampler: { class_type: 'SamplerCustomAdvanced', inputs: { guider: ['guider', 0], latent_image: ['condition', 1] } },
    split: { class_type: 'LTXVSeparateAVLatent', inputs: { av_latent: ['sampler', 0] } },
    decode: { class_type: 'VAEDecode', inputs: { samples: ['split', 0], vae: ['vae', 0] } },
    decodeAudio: { class_type: 'VAEDecodeAudio', inputs: { samples: ['split', 1], vae: ['audioVae', 0] } },
  };
}

let info = schemas();
beforeEach(() => {
  vi.clearAllMocks();
  info = schemas();
  mocks.desktop.mockReturnValue(true);
  mocks.getSettings.mockResolvedValue({ h3Memory: { ...DEFAULT_COMFY_H3_MEMORY_SETTINGS, preset: 'safe12' } });
  mocks.fetch.mockResolvedValue({ ok: true, json: async () => info });
});

describe('ComfyUI H3 memory policy selection', () => {
  it('off and non-H3 workflows make no native settings or network calls', async () => {
    const graph = workflow();
    const original = structuredClone(graph);
    expect(await applyComfyH3Memory(graph, 'http://localhost:8188', 'off')).toBeUndefined();
    expect(graph).toEqual(original);
    expect(await applyComfyH3Memory({ one: { class_type: 'WanImageToVideo', inputs: {} } }, 'http://localhost:8188', 'safe12')).toBeUndefined();
    expect(mocks.getSettings).not.toHaveBeenCalled();
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it('inherits local desktop settings only; an explicit preset works on remote services', async () => {
    expect(await resolveComfyH3MemorySettings('http://remote.test:8188')).toBeUndefined();
    mocks.desktop.mockReturnValue(false);
    expect(await resolveComfyH3MemorySettings('http://localhost:8188')).toBeUndefined();
    expect(mocks.getSettings).not.toHaveBeenCalled();
    const report = await applyComfyH3Memory(workflow(), 'https://remote.test/comfy', 'safe12');
    expect(report?.preset).toBe('safe12');
    expect(mocks.fetch.mock.calls[0][0]).toBe('https://remote.test/comfy/object_info');
  });

  it('rejects an inherited setting change before schema reads or mutations', async () => {
    const graph = workflow();
    const before = structuredClone(graph);
    const expected = comfyH3MemoryFingerprint({ ...DEFAULT_COMFY_H3_MEMORY_SETTINGS, preset: 'safe12' });
    mocks.getSettings.mockResolvedValue({ h3Memory: { ...DEFAULT_COMFY_H3_MEMORY_SETTINGS, preset: 'off' } });
    await expect(applyComfyH3Memory(graph, 'http://localhost:8188', 'inherit', undefined, expected)).rejects.toThrow('H3 显存设置已变化');
    expect(graph).toEqual(before);
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it('uses canonical safe12 settings even if saved custom fields remain from an earlier preset', async () => {
    mocks.getSettings.mockResolvedValue({ h3Memory: { ...DEFAULT_COMFY_H3_MEMORY_SETTINGS, preset: 'safe12', attentionHeadChunks: 12, referenceImageMaxSize: 1024 } });
    expect(await resolveComfyH3MemorySettings('http://localhost:8188')).toEqual({ ...DEFAULT_COMFY_H3_MEMORY_SETTINGS, preset: 'safe12' });
  });

  it('rejects a batch whose workflow is no longer H3 before reading settings or contacting ComfyUI', async () => {
    const graph = { one: { class_type: 'WanImageToVideo', inputs: {} } };
    await expect(applyComfyH3Memory(graph, 'http://localhost:8188', 'inherit', undefined, 'previous-policy')).rejects.toThrow('H3 工作流已变化');
    expect(mocks.fetch).not.toHaveBeenCalled();
    expect(mocks.getSettings).not.toHaveBeenCalled();
  });

  it('recognizes API and editor workflows without mistaking ordinary Hunyuan/Wan workflows', () => {
    expect(isComfyH3Workflow(JSON.stringify(workflow()))).toBe(true);
    expect(isComfyH3Workflow(JSON.stringify({ nodes: [{ type: 'UNETLoader', widgets_values: ['minimax_h3_ref2va.safetensors'] }] }))).toBe(true);
    expect(isComfyH3Workflow(JSON.stringify({ one: { class_type: 'WanImageToVideo', inputs: {} } }))).toBe(false);
    expect(isComfyH3Workflow('{')).toBe(false);
  });
});

describe('ComfyUI H3 execution copy transformations', () => {
  it('applies chunking, CPU encoding, reference scaling and tiled video VAE without changing models/output/video refs', async () => {
    const original = workflow();
    const graph = structuredClone(original);
    const report = await applyComfyH3Memory(graph, 'http://localhost:8188');
    expect(report?.applied).toEqual(['attention', 'feedForward', 'textEncoderCpu', 'referenceImages', 'vaeTiling']);
    const patches = Object.values(graph).filter((node) => node.class_type.startsWith('MiniMax') && node.class_type !== 'MiniMaxH3ReferenceToVideo');
    expect(patches.map((node) => node.class_type)).toEqual(['MiniMaxLowVRAMAttention', 'MiniMaxChunkFeedForward']);
    expect(patches[0].inputs.head_chunks).toBe(4);
    expect(patches[1].inputs).toMatchObject({ chunks: 2, seq_threshold: 4096 });
    expect(graph.clip.inputs.device).toBe('cpu');
    expect(graph.decode).toMatchObject({ class_type: 'VAEDecodeTiled', inputs: { tile_size: 256, temporal_size: 16, samples: ['split', 0], vae: ['vae', 0] } });
    const scaled = graph[String((graph.condition.inputs['ref_images.ref_image_0'] as unknown[])[0])];
    expect(scaled).toMatchObject({ class_type: 'ImageResize+', inputs: { image: ['image', 0], width: 512, height: 512,
      condition: 'downscale if bigger', method: 'keep proportion', multiple_of: 0 } });
    for (const key of ['model', 'image', 'referenceVideo', 'audioVae', 'decodeAudio']) expect(graph[key]).toEqual(original[key]);
    expect(graph.condition.inputs).toMatchObject({ width: 1344, height: 768, length: 362, 'ref_videos.ref_video_0': ['referenceVideo', 0] });
    expect(original.clip.inputs.device).toBe('default');
    expect(original.decode.class_type).toBe('VAEDecode');
  });

  it('reuses matching existing patch and scale nodes instead of adding a second patch chain', async () => {
    const graph = workflow();
    await applyComfyH3Memory(graph, 'http://localhost:8188', 'safe12');
    const once = structuredClone(graph);
    await applyComfyH3Memory(graph, 'http://localhost:8188', 'safe12');
    expect(graph).toEqual(once);
  });

  it('custom settings can keep the encoder, references and VAE unchanged while applying model patches', async () => {
    const graph = workflow();
    const before = structuredClone(graph);
    mocks.getSettings.mockResolvedValue({ h3Memory: { ...DEFAULT_COMFY_H3_MEMORY_SETTINGS, preset: 'custom',
      textEncoderDevice: 'auto', referenceImageMaxSize: 0, vaeTiling: false, attentionHeadChunks: 2,
    } });
    const report = await applyComfyH3Memory(graph, 'http://localhost:8188');
    expect(report?.applied).toEqual(['attention', 'feedForward']);
    expect(Object.values(graph).find((node) => node.class_type === 'MiniMaxLowVRAMAttention')?.inputs.head_chunks).toBe(2);
    expect(graph.clip).toEqual(before.clip);
    expect(graph.condition).toEqual(before.condition);
    expect(graph.decode).toEqual(before.decode);
  });

  it('keeps ImageToVideo first/last frames at their original input path and never requires the reference-resize plugin', async () => {
    const graph = workflow();
    graph.condition.class_type = 'MiniMaxH3ImageToVideo';
    delete graph.condition.inputs['ref_images.ref_image_0'];
    delete graph.condition.inputs['ref_videos.ref_video_0'];
    graph.condition.inputs.first_frame = ['image', 0];
    graph.condition.inputs.last_frame = ['referenceVideo', 0];
    Object.assign(info, { MiniMaxH3ImageToVideo: spec({ clip: field('CLIP'), vae: field('VAE'), width: field('INT'), height: field('INT'), length: field('INT') },
      ['CONDITIONING', 'LATENT'], { first_frame: field('IMAGE'), last_frame: field('IMAGE') }) });
    delete (info as Partial<ReturnType<typeof schemas>>)['ImageResize+'];
    const report = await applyComfyH3Memory(graph, 'http://localhost:8188', 'safe12');
    expect(report?.applied).not.toContain('referenceImages');
    expect(graph.condition.inputs.first_frame).toEqual(['image', 0]);
    expect(graph.condition.inputs.last_frame).toEqual(['referenceVideo', 0]);
  });

  it('only changes the H3 sampler branch in a mixed-model graph', async () => {
    const graph = workflow();
    graph.otherModel = { class_type: 'UNETLoader', inputs: { unet_name: 'wan.safetensors' } };
    graph.otherCondition = { class_type: 'OtherCondition', inputs: {} };
    graph.otherGuider = { class_type: 'BasicGuider', inputs: { model: ['otherModel', 0], conditioning: ['otherCondition', 0] } };
    graph.otherSampler = { class_type: 'SamplerCustomAdvanced', inputs: { guider: ['otherGuider', 0], latent_image: ['condition', 1] } };
    Object.assign(info, { OtherCondition: spec({}, ['CONDITIONING']) });
    const before = structuredClone(graph.otherGuider);
    await applyComfyH3Memory(graph, 'http://localhost:8188', 'safe12');
    expect(graph.otherGuider).toEqual(before);
  });

  it('rejects changing an existing patch shared transitively through a later MODEL branch', async () => {
    const graph = workflow();
    graph.existingAttention = { class_type: 'MiniMaxLowVRAMAttention', inputs: { model: ['model', 0], head_chunks: 2 } };
    graph.sharedModel = { class_type: 'ModelPassthrough', inputs: { model: ['existingAttention', 0] } };
    graph.guider.inputs.model = ['sharedModel', 0];
    graph.otherCondition = { class_type: 'OtherCondition', inputs: {} };
    graph.otherGuider = { class_type: 'BasicGuider', inputs: { model: ['sharedModel', 0], conditioning: ['otherCondition', 0] } };
    Object.assign(info, { ModelPassthrough: spec({ model: field('MODEL') }, ['MODEL']), OtherCondition: spec({}, ['CONDITIONING']) });
    const before = structuredClone(graph);
    await expect(applyComfyH3Memory(graph, 'http://localhost:8188', 'safe12')).rejects.toThrow(/H3/);
    expect(graph).toEqual(before);
  });

  it.each(['missing-plugin', 'wrong-model-output', 'narrow-range', 'connected-setting', 'audio-output', 'encapsulated'])(
    'fails atomically for %s instead of claiming that an optimization took effect', async (failure) => {
      const graph = workflow();
      if (failure === 'missing-plugin') delete (info as Partial<ReturnType<typeof schemas>>).MiniMaxLowVRAMAttention;
      if (failure === 'wrong-model-output') info.MiniMaxLowVRAMAttention.output = ['CLIP'];
      if (failure === 'narrow-range') info.MiniMaxLowVRAMAttention.input.required.head_chunks = field('INT', { min: 1, max: 2 });
      if (failure === 'connected-setting') graph.clip.inputs.device = ['image', 0];
      if (failure === 'audio-output') graph.decode.inputs.samples = ['split', 1];
      if (failure === 'encapsulated') graph.condition.class_type = 'easy multitrackProject';
      const before = structuredClone(graph);
      await expect(applyComfyH3Memory(graph, 'http://localhost:8188', 'safe12')).rejects.toThrow(/H3/);
      expect(graph).toEqual(before);
    },
  );

  it('does not persist a response body or address in compatibility errors', async () => {
    mocks.fetch.mockResolvedValue({ ok: false, status: 403, body: { cancel: async () => {} }, text: async () => 'secret upstream body' });
    const graph = workflow();
    const before = structuredClone(graph);
    const error = await applyComfyH3Memory(graph, 'https://private.example/comfy', 'safe12').catch((cause: Error) => cause);
    expect(String(error)).not.toMatch(/secret|private\.example/);
    expect(error).toMatchObject({ cause: 'http-403' });
    expect(graph).toEqual(before);
  });

  it.each([401, 403])('reports HTTP %s as an access issue before submission', async (status) => {
    mocks.fetch.mockResolvedValue({ ok: false, status, body: { cancel: async () => {} } });
    const graph = workflow();
    const before = structuredClone(graph);
    await expect(applyComfyH3Memory(graph, 'http://localhost:8188', 'safe12')).rejects.toThrow(`HTTP ${status}`);
    expect(graph).toEqual(before);
  });

  it('requires a proven downscale-only resize option and does not fall back to enlarging small pictures', async () => {
    info['ImageResize+'].input.required.condition = field(['always']);
    const graph = workflow();
    const before = structuredClone(graph);
    await expect(applyComfyH3Memory(graph, 'http://localhost:8188', 'safe12')).rejects.toThrow('ComfyUI_essentials');
    expect(graph).toEqual(before);
  });

  it.each(['shared-outside-h3', 'unknown-clip-leaf'])('does not claim all encoding is on CPU for %s', async (kind) => {
    const graph = workflow();
    if (kind === 'shared-outside-h3') {
      graph.otherText = { class_type: 'CLIPTextEncode', inputs: { clip: ['clip', 0], text: 'other branch' } };
      Object.assign(info, { CLIPTextEncode: spec({ clip: field('CLIP'), text: field('STRING') }, ['CONDITIONING']) });
    } else {
      graph.unknownClip = { class_type: 'DualCLIPLoader', inputs: {} };
      graph.mergedClip = { class_type: 'ClipMerge', inputs: { one: ['clip', 0], two: ['unknownClip', 0] } };
      graph.condition.inputs.clip = ['mergedClip', 0];
      Object.assign(info, { DualCLIPLoader: spec({}, ['CLIP']), ClipMerge: spec({ one: field('CLIP'), two: field('CLIP') }, ['CLIP']) });
    }
    const before = structuredClone(graph);
    await expect(applyComfyH3Memory(graph, 'http://localhost:8188', 'safe12')).rejects.toThrow(/H3/);
    expect(graph).toEqual(before);
  });

  it('an aborted schema query leaves the execution graph untouched', async () => {
    const graph = workflow();
    const before = structuredClone(graph);
    const controller = new AbortController();
    mocks.fetch.mockImplementation(async () => {
      controller.abort(new DOMException('请求已取消', 'AbortError'));
      return { ok: true, json: async () => info };
    });
    await expect(applyComfyH3Memory(graph, 'http://localhost:8188', 'safe12', controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(graph).toEqual(before);
  });
});
