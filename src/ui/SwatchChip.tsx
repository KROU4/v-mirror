// Colour swatch as the game draws it: the creator's own thumbnail (gradient, iris photo,
// nail art, metal) from the connected asset pack, and until it loads — or without a
// pack — a CSS approximation built from the committed colour facts (swatch.ts).
import { memo, useEffect, useState, useSyncExternalStore, type CSSProperties } from 'react';
import { gameAssetUrl, getPackState, subscribePack, type PackState } from '../assets/pack';
import type { Gender, Option, Variant } from '../model/catalog';
import { lookupSwatch, swatchPackPath, swatchStyle, swatchTable } from './swatch';

export function usePackState(): PackState {
  return useSyncExternalStore(subscribePack, getPackState, getPackState);
}

/** Whether the slot is drawn with colour swatches in the creator (and the variant has any). */
export function slotHasSwatches(gender: Gender, slotId: string, variant: Variant): boolean {
  const table = swatchTable(gender);
  if (!table.slots[slotId]) return false;
  return variant.options.some((o) => !!lookupSwatch(table, slotId, o));
}

/**
 * Pack path of the option's thumbnail, or null when the pack has none for it: options
 * without an icon have a per-index image only in slots whose order is the same in every
 * variant. Asking for files that do not exist would only produce 404s.
 */
export function packSwatchPath(gender: Gender, slotId: string, o: Pick<Option, 'i' | 'icon'>): string | null {
  if (o.icon) return swatchPackPath(gender, slotId, o.i, o.icon);
  const s = swatchTable(gender).slots[slotId];
  return s?.stable && s.byIndex?.[String(o.i)] ? swatchPackPath(gender, slotId, o.i) : null;
}

// Resolved URLs per connected pack (packId, not the state object: "busy" and error
// updates of the same pack must not drop the cache): switching rows does not blink.
let cachePack: number | undefined;
const cache = new Map<string, string>();
const failed = new Set<string>();
/** image URLs the browser has already decoded once */
const decoded = new Set<string>();

function forPack(id: number | undefined) {
  if (id === cachePack) return;
  cachePack = id;
  cache.clear();
  failed.clear();
  // blob: URLs of the previous pack are revoked with it: nothing to remember about them
  decoded.clear();
}

function cached(id: number | undefined, path: string | null): string | null {
  if (id !== cachePack) return null;
  return path ? cache.get(path) ?? null : null;
}

export const Swatch = memo(function Swatch({
  gender,
  slotId,
  option,
  className,
}: {
  gender: Gender;
  slotId: string;
  option: Option | undefined;
  className?: string;
}) {
  const pack = usePackState();
  const ready = pack.status === 'ready';
  const id = ready ? pack.packId : undefined;
  const path = ready && option ? packSwatchPath(gender, slotId, option) : null;
  const [url, setUrl] = useState<{ id: number | undefined; path: string; url: string } | null>(() => {
    const u = ready ? cached(id, path) : null;
    return u && path ? { id, path, url: u } : null;
  });
  const [loaded, setLoaded] = useState<string | null>(null);

  useEffect(() => {
    if (!ready || !path) return;
    forPack(id);
    if (failed.has(path)) return;
    const hit = cache.get(path);
    if (hit) {
      setUrl({ id, path, url: hit });
      return;
    }
    let off = false;
    gameAssetUrl(path)
      .then((u) => {
        // an answer from a pack that has since been replaced belongs to nobody
        if (cachePack !== id) return;
        cache.set(path, u);
        if (!off) setUrl({ id, path, url: u });
      })
      .catch((e: unknown) => {
        // disconnected meanwhile: not a missing file, try again with the next pack
        if (cachePack !== id || (e as Error)?.name === 'PackNotConnected') return;
        failed.add(path);
      });
    return () => {
      off = true;
    };
  }, [ready, id, path]);

  const desc = option ? lookupSwatch(swatchTable(gender), slotId, option) : undefined;
  const img = ready && path && !(id === cachePack && failed.has(path)) ? (url && url.id === id && url.path === path ? url.url : cached(id, path)) : null;
  const showImg = !!img && (loaded === img || decoded.has(img));
  const style: CSSProperties = showImg ? {} : swatchStyle(desc);
  return (
    <span className={`swatch ${className ?? ''}`} style={style} data-src={showImg ? 'pack' : 'css'} aria-hidden="true">
      {img && (
        <img
          src={img}
          alt=""
          draggable={false}
          decoding="async"
          onLoad={() => {
            decoded.add(img);
            setLoaded(img);
          }}
          onError={() => {
            if (path && id === cachePack) {
              failed.add(path);
              cache.delete(path);
            }
            setUrl(null);
          }}
          style={showImg ? undefined : { opacity: 0 }}
        />
      )}
    </span>
  );
});
