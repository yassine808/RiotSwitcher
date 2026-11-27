# -*- mode: python ; coding: utf-8 -*-
"""PyInstaller spec for the RiotSwitcher Python backend.

Produces a one-folder build in release/python/ containing main.exe plus all
bundled stdlib/third-party modules. electron-builder copies this folder into
the app's resources as resources/python so the packaged Electron app can spawn
the backend without a system Python install.

Build:  pyinstaller build/build-python.spec --noconfirm
"""
import importlib.util
import os

from PyInstaller.utils.hooks import collect_submodules, collect_data_files

ROOT = os.path.abspath(os.getcwd())
SRC = os.path.join(ROOT, "src", "backend")
OUT = os.path.join(ROOT, "release", "python")

hiddenimports = collect_submodules("cryptography")
datas = collect_data_files("cryptography")

# A bare PyInstaller bootloader with no version resource is one of the shapes
# antivirus heuristics score highest. The resource is generated from
# package.json so it can never drift from the release.
_version_module_path = os.path.join(ROOT, "build", "write_version_info.py")
_version_module_spec = importlib.util.spec_from_file_location(
    "write_version_info", _version_module_path
)
_version_module = importlib.util.module_from_spec(_version_module_spec)
_version_module_spec.loader.exec_module(_version_module)
VERSION_FILE = _version_module.write_version_file(ROOT)

a = Analysis(
    [os.path.join(SRC, "main.py")],
    pathex=[SRC],
    binaries=[],
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=["tkinter", "test", "unittest", "pydoc", "doctest"],
    noarchive=False,
)

pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="main",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    console=True,
    disable_windowed_traceback=False,
    version=VERSION_FILE,
)
coll = COLLECT(
    exe,
    a.binaries,
    a.datas,
    strip=False,
    upx=False,
    name="python",
)
