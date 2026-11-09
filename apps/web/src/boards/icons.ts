import {
  Activity,
  Archive,
  ArrowLeftRight,
  Box,
  Building,
  Clock,
  Cloud,
  Cog,
  Copy,
  CreditCard,
  Database,
  DatabaseZap,
  DoorOpen,
  Gauge,
  Globe,
  Hand,
  Key,
  KeyRound,
  Layers,
  ListOrdered,
  Lock,
  Mail,
  Map as MapIcon,
  Monitor,
  Network,
  Plug,
  Radio,
  Scale,
  Search,
  Shield,
  ShieldCheck,
  Signpost,
  Smartphone,
  Sparkles,
  Square,
  Terminal,
  Timer,
  ToggleRight,
  User,
  Warehouse,
  Waves,
  Webhook,
  Wrench,
  Zap,
  type IconNode,
} from 'lucide';
import type { BinaryFileData } from '@excalidraw/excalidraw/types';

/**
 * Component icons (D03 wave 1a). The catalog names Lucide icons (`ComponentTypeInfo.icon`); they are
 * bundled from the vanilla `lucide` package (ISC; icon nodes, no React render needed, tree-shaken by
 * name) and drawn on the board as Excalidraw image elements whose file is an SVG data URL. The
 * file id is stable per icon and colour (`atlas-icon-<name>-<hex>`), so every board carries one
 * small file per icon it uses and an icon change is just a new `fileId`.
 */
const ICONS: Record<string, IconNode> = {
  activity: Activity,
  archive: Archive,
  'arrow-left-right': ArrowLeftRight,
  box: Box,
  building: Building,
  clock: Clock,
  cloud: Cloud,
  cog: Cog,
  copy: Copy,
  'credit-card': CreditCard,
  database: Database,
  'database-zap': DatabaseZap,
  'door-open': DoorOpen,
  gauge: Gauge,
  globe: Globe,
  hand: Hand,
  key: Key,
  'key-round': KeyRound,
  layers: Layers,
  'list-ordered': ListOrdered,
  lock: Lock,
  mail: Mail,
  map: MapIcon,
  monitor: Monitor,
  network: Network,
  plug: Plug,
  radio: Radio,
  scale: Scale,
  search: Search,
  shield: Shield,
  'shield-check': ShieldCheck,
  signpost: Signpost,
  smartphone: Smartphone,
  sparkles: Sparkles,
  square: Square,
  terminal: Terminal,
  timer: Timer,
  'toggle-right': ToggleRight,
  user: User,
  warehouse: Warehouse,
  waves: Waves,
  webhook: Webhook,
  wrench: Wrench,
  zap: Zap,
};

const esc = (v: string) => v.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

/** Standalone SVG markup for an icon (explicit size and stroke: data-URL images have no currentColor). */
export function iconSvg(name: string, color: string, size = 48): string {
  const node = ICONS[name] ?? Square;
  const children = node
    .map(
      ([tag, attrs]) =>
        `<${tag} ${Object.entries(attrs)
          .map(([k, v]) => `${k}="${esc(String(v))}"`)
          .join(' ')}/>`,
    )
    .join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${children}</svg>`;
}

export const iconFileId = (name: string, color: string) =>
  `atlas-icon-${ICONS[name] ? name : 'square'}-${color.replace('#', '')}`;

/** Excalidraw `BinaryFileData` for an icon. */
export function iconFile(name: string, color: string): BinaryFileData {
  return {
    id: iconFileId(name, color) as BinaryFileData['id'],
    mimeType: 'image/svg+xml' as const,
    dataURL: `data:image/svg+xml;base64,${btoa(iconSvg(name, color))}` as BinaryFileData['dataURL'],
    created: 0,
  };
}

/** The icon's shapes (`[tag, attrs]`), for rendering it as React SVG in panels. */
export const iconNode = (name: string): IconNode => ICONS[name] ?? Square;
