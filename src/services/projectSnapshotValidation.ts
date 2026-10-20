/** Shared persistence boundary; importing it must not load screenshot or DOM code. */
export const PROJECT_SNAPSHOT_MAX_DATA_URL_LENGTH = 350_000;

export function isProjectSnapshotDataUrl(value: unknown): value is string {
  return typeof value === 'string'
    && value.startsWith('data:image/')
    && value.length <= PROJECT_SNAPSHOT_MAX_DATA_URL_LENGTH;
}
