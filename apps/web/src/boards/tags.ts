/**
 * How Atlas recognises its own elements in an Excalidraw scene (D03). Every element that stands for
 * a registry entry carries `customData.atlas = { kind, id, role? }`:
 *
 * - `component`: every member of a component's group. `role` says which part it is: `box` (the
 *   container rectangle the arrows bind to; `Component.elementIds[0]`), `label` (the editable name:
 *   bound text of the box, or free text on a boundary), `icon`, `type`, `badges`.
 * - `connection`: the arrow (`Connection.elementId`). Its label is bound text (`containerId` = arrow).
 * - `frame`: an Excalidraw frame standing for a `BoardFrame`.
 * - `scenario-step`: a circled step number (wave 1b).
 * - `sticky`: a sticky note (rectangle + bound text); not in the registry.
 *
 * Kept free of Excalidraw imports so the registry logic can be unit-tested under node.
 */
export type AtlasTagKind = 'component' | 'connection' | 'scenario-step' | 'frame' | 'sticky';
export type ComponentPartRole = 'box' | 'label' | 'icon' | 'type' | 'badges';

export interface AtlasTag {
  kind: AtlasTagKind;
  id: string;
  role?: ComponentPartRole;
}

/** The fields of an Excalidraw element the registry logic reads (structural, so tests can fake them). */
export interface SceneElementLike {
  id: string;
  type: string;
  version: number;
  isDeleted?: boolean;
  customData?: Record<string, unknown> | null;
  containerId?: string | null;
  frameId?: string | null;
  groupIds?: readonly string[];
  text?: string;
  originalText?: string;
  name?: string | null;
  startBinding?: { elementId: string } | null;
  endBinding?: { elementId: string } | null;
  boundElements?: readonly { id: string; type: string }[] | null;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
}

export const atlasTag = (el: { customData?: unknown } | undefined): AtlasTag | undefined =>
  (el?.customData as { atlas?: AtlasTag } | undefined | null)?.atlas;

export const tagData = (tag: AtlasTag, customData?: Record<string, unknown> | null) => ({
  ...(customData ?? {}),
  atlas: tag,
});
