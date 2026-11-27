"""Generate the Windows version resource for the PyInstaller backend.

`build/build-python.spec` passes the result to `EXE(version=...)`, which is what
puts CompanyName, ProductName and FileVersion into `main.exe`. An unsigned
PyInstaller bootloader with an empty resource is one of the shapes antivirus
heuristics score highest, so these fields are not cosmetic.

The version comes from package.json, the single source of truth; run this file
directly to regenerate `build/version_info.txt` without a full build.

    python build/write_version_info.py
"""

import json
import os

TEMPLATE = """VSVersionInfo(
  ffi=FixedFileInfo(
    filevers=({{QUAD}}),
    prodvers=({{QUAD}}),
    mask=0x3f,
    flags=0x0,
    OS=0x40004,
    fileType=0x1,
    subtype=0x0,
    date=(0, 0),
  ),
  kids=[
    StringFileInfo(
      [
        StringTable(
          "040904B0",
          [
            StringStruct("CompanyName", "Yassine"),
            StringStruct("FileDescription", "RiotSwitcher backend"),
            StringStruct("FileVersion", "{{VERSION}}"),
            StringStruct("InternalName", "main"),
            StringStruct("LegalCopyright", "Copyright (C) 2026 RiotSwitcher Contributors"),
            StringStruct("OriginalFilename", "main.exe"),
            StringStruct("ProductName", "RiotSwitcher"),
            StringStruct("ProductVersion", "{{VERSION}}"),
          ],
        )
      ]
    ),
    VarFileInfo([VarStruct("Translation", [1033, 1200])]),
  ],
)
"""


def read_version(root):
    with open(os.path.join(root, "package.json"), encoding="utf-8") as handle:
        return json.load(handle)["version"]


def render(version):
    numbers = [int(part) for part in version.split(".")]
    numbers += [0] * (4 - len(numbers))
    quad = ", ".join(str(number) for number in numbers)
    return TEMPLATE.replace("{{QUAD}}", quad).replace("{{VERSION}}", version)


def write_version_file(root):
    """Write build/version_info.txt and return its path."""
    path = os.path.join(root, "build", "version_info.txt")
    with open(path, "w", encoding="utf-8", newline="\n") as handle:
        handle.write(render(read_version(root)))
    return path


if __name__ == "__main__":
    print(write_version_file(os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))))
