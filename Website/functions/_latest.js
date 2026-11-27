// Reads the newest public GitHub release and works out the build's file names.
export const FEED = "https://github.com/yassine808/RiotSwitcher/releases/latest/download";

/** Reads one top-level `key: value` line from latest.yml. */
function yamlValue(yml, key) {
  const prefix = key + ":";
  for (const line of yml.split("\n")) {
    const text = line.trim();
    if (text.startsWith(prefix)) {
      return text.slice(prefix.length).trim().replace(/^['"]|['"]$/g, "");
    }
  }
  return undefined;
}

export async function getLatest() {
  const res = await fetch(`${FEED}/latest.yml`, { cf: { cacheTtl: 60 } });
  if (!res.ok) throw new Error(`feed ${res.status}`);
  const yml = await res.text();
  const version = yamlValue(yml, "version");
  if (!version) throw new Error("no version in latest.yml");
  const path = yamlValue(yml, "path");
  const url = (name) => (/^https?:\/\//.test(name) ? name : `${FEED}/${name}`);
  return {
    version,
    setup: url(path || `RiotSwitcher-Setup-${version}.exe`),
    portable: url(`RiotSwitcher-${version}-portable.exe`),
  };
}
