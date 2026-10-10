// File-tree icons from VS Code's Material Icon Theme. Files are matched the way the theme
// does it: exact file name, then the longest dotted extension (so "x.d.ts" beats "ts"), then
// a plain file. Folders go by path: only our special folders (build.mjs FOLDERS) get an
// icon, so players can tell them apart; any other folder is plain. The map and SVGs are
// copied into /icons by build.mjs.

type IconMap = {
  folders: Record<string, string>; // special folder path -> icon (its open one adds "-open")
  fileNames: Record<string, string>;
  fileExtensions: Record<string, string>;
};

let map: IconMap | null = null;

// loadIcons fetches the map once; until then (or if it fails) everything gets the defaults.
export async function loadIcons() {
  try {
    // Always fresh: the icons themselves are cached for a day, but an old map after a
    // deploy (a different shape) once left the tree empty.
    const r = await fetch('/icons/map.json', { cache: 'no-cache' });
    if (r.ok) map = await r.json();
  } catch {
    /* defaults it is */
  }
}

// iconURL: a folder needs its whole path (from the top of Files); a file's name is enough.
export function iconURL(path: string, dir: boolean, open: boolean): string {
  return `/icons/${dir ? folderIcon(path, open) : fileIcon(path.slice(path.lastIndexOf('/') + 1).toLowerCase())}.svg`;
}

function folderIcon(path: string, open: boolean): string {
  const icon = map?.folders?.[path] ?? 'folder';
  return open ? icon + '-open' : icon;
}

function fileIcon(name: string): string {
  const exact = map?.fileNames?.[name];
  if (exact) return exact;
  for (let i = name.indexOf('.'); i >= 0; i = name.indexOf('.', i + 1)) {
    const icon = map?.fileExtensions?.[name.slice(i + 1)];
    if (icon) return icon;
  }
  return 'file';
}
