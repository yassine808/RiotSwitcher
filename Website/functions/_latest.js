// Reads the newest public GitHub release and works out the build's file names.
export const FEED = "https://github.com/yassine808/RiotSwitcher/releases/latest/download";

export async function getLatest() {
  const res = await fetch(`${FEED}/latest.yml`, { cf: { cacheTtl: 60 } });
  if (!res.ok) throw new Error(`feed ${res.status}`);
  const yml = await res.text();
  const version = (yml.match(/^version:\s*['"]?([^'"\s]+)/m) || [])[1];
  if (!version) throw new Error("no version in latest.yml");
  const path = (yml.match(/^path:\s*['"]?([^'"\n]+?)['"]?\s*$/m) || [])[1];
  const url = (name) => (/^https?:\/\//.test(name) ? name : `${FEED}/${name}`);
  return {
    version,
    setup: url(path || `RiotSwitcher-Setup-${version}.exe`),
    portable: url(`RiotSwitcher-${version}-portable.exe`),
  };
}
