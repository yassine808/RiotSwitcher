// Reads the public R2 feed and works out the newest build's file names.
export const FEED = "https://pub-6d3d6d22222242dab87967c474f39ada.r2.dev";

export async function getLatest() {
  const res = await fetch(`${FEED}/latest.yml`, { cf: { cacheTtl: 60 } });
  if (!res.ok) throw new Error(`feed ${res.status}`);
  const yml = await res.text();
  const version = (yml.match(/^version:\s*['"]?([^'"\s]+)/m) || [])[1];
  if (!version) throw new Error("no version in latest.yml");
  const path = (yml.match(/^path:\s*['"]?([^'"\n]+?)['"]?\s*$/m) || [])[1];
  return {
    version,
    setup: `${FEED}/${path || `RiotSwitcher-Setup-${version}.exe`}`,
    portable: `${FEED}/RiotSwitcher-${version}-portable.exe`,
  };
}
