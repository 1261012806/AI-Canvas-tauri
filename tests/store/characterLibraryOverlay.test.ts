import { describe, expect, it } from 'vitest';
import { createStore } from 'zustand/vanilla';
import { createUISlice } from '../../src/store/store.ui';
import type { AppState } from '../../src/store/useAppStore';
import type { CharacterLibraryOpenRequest } from '../../src/types/dramaAssets';

const modes = ['page', 'modal', 'drawer'] as const;
const sections = ['voice', 'action'] as const;
const sourceRequest: CharacterLibraryOpenRequest = {
  origin: 'assets', scope: 'global', characterId: 'global-character', section: 'voice',
};
const assetRequest = { tab: 'permanent' as const, folder: { kind: 'all' as const } };

function fixture(mode: typeof modes[number]) {
  const store = createStore<AppState>()((set, get, api) => createUISlice(set, get, api) as AppState);
  store.getState().setAssetsPanelOpen(true, mode, assetRequest);
  return store;
}

describe('character library overlay above the asset library', () => {
  it.each(modes.flatMap((mode) => sections.map((section) => ({ mode, section }))))(
    'keeps the $mode asset library when its character $section section opens', ({ mode, section }) => {
      const store = fixture(mode);
      const request = { ...sourceRequest, section };
      store.getState().setCharacterLibraryOpen(true, request);

      expect(store.getState()).toMatchObject({
        assetsPanelOpen: true, assetsPanelMode: mode, assetsPanelRequest: assetRequest,
        characterLibraryOpen: true, characterLibraryRequest: request,
        characterActionLibraryOpen: section === 'action',
      });
    },
  );

  it.each(modes)('preserves the %s background while opening and closing the nested action library', (mode) => {
    const store = fixture(mode);
    store.getState().setCharacterLibraryOpen(true, sourceRequest);
    store.getState().setCharacterActionLibraryOpen(true);
    expect(store.getState()).toMatchObject({
      assetsPanelOpen: true, assetsPanelMode: mode, assetsPanelRequest: assetRequest,
      characterLibraryOpen: true, characterActionLibraryOpen: true, characterLibraryRequest: sourceRequest,
    });

    store.getState().setCharacterActionLibraryOpen(false);
    expect(store.getState()).toMatchObject({
      assetsPanelOpen: true, assetsPanelMode: mode, assetsPanelRequest: assetRequest,
      characterLibraryOpen: true, characterActionLibraryOpen: false,
    });
  });

  it.each(modes)('returns to the same %s asset library when the character layer closes', (mode) => {
    const store = fixture(mode);
    store.getState().setCharacterLibraryOpen(true, { ...sourceRequest, section: 'action' });
    store.getState().setCharacterLibraryOpen(false);
    expect(store.getState()).toMatchObject({
      assetsPanelOpen: true, assetsPanelMode: mode, assetsPanelRequest: assetRequest,
      characterLibraryOpen: false, characterActionLibraryOpen: false, characterLibraryRequest: null,
    });
  });

  it.each(modes)('closes resource-owned character and action layers with their %s background', (mode) => {
    const store = fixture(mode);
    store.getState().setCharacterLibraryOpen(true, { ...sourceRequest, section: 'action' });
    store.getState().setAssetsPanelOpen(false);
    expect(store.getState()).toMatchObject({
      assetsPanelOpen: false, assetsPanelRequest: null,
      characterLibraryOpen: false, characterActionLibraryOpen: false, characterLibraryRequest: null,
    });
  });

  it.each(modes)('keeps ordinary character and action entry points exclusive with the %s asset library', (mode) => {
    const characters = fixture(mode);
    characters.getState().setCharacterLibraryOpen(true, { scope: 'global', section: 'voice' });
    expect(characters.getState()).toMatchObject({ assetsPanelOpen: false, characterLibraryOpen: true });

    const actions = fixture(mode);
    actions.getState().setCharacterActionLibraryOpen(true);
    expect(actions.getState()).toMatchObject({ assetsPanelOpen: false, characterActionLibraryOpen: true });
  });

  it('does not reuse an old resource origin for an ordinary action entry point', () => {
    const store = fixture('page');
    store.setState({ characterLibraryRequest: sourceRequest, characterLibraryOpen: false });
    store.getState().setCharacterActionLibraryOpen(true);
    expect(store.getState()).toMatchObject({ assetsPanelOpen: false, characterActionLibraryOpen: true });
  });

  it('does not reopen a closed background just because a character request names the asset library', () => {
    const store = fixture('page');
    store.getState().setAssetsPanelOpen(false);
    store.getState().setCharacterLibraryOpen(true, sourceRequest);
    expect(store.getState()).toMatchObject({ assetsPanelOpen: false, characterLibraryOpen: true });
  });

  it('clears the old overlay source when reopening the asset library through its ordinary entry point', () => {
    const store = fixture('page');
    store.getState().setCharacterLibraryOpen(true, { ...sourceRequest, section: 'action' });
    store.getState().setAssetsPanelOpen(true, 'drawer');
    expect(store.getState()).toMatchObject({
      assetsPanelOpen: true, assetsPanelMode: 'drawer', assetsPanelRequest: null,
      characterLibraryOpen: false, characterActionLibraryOpen: false, characterLibraryRequest: null,
    });
  });
});
