/** Gallery / screenshot forcing of pseudo-states via globals.css `[data-state]` hooks. */
export type GalleryVisualState = 'hover' | 'focus' | 'active';

export function galleryStateProps(state?: GalleryVisualState): { 'data-state'?: GalleryVisualState } {
  return state ? { 'data-state': state } : {};
}
