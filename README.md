# RiotSwitcher

Windows app that switches between your Riot accounts without typing the
password again. It saves the Riot Client login of each account and puts the
one you pick back in place, so VALORANT and League of Legends start as the
right user. Profiles also carry their ranks, so you can see which account is
which before you switch.

## Download

[![Download RiotSwitcher Setup](https://img.shields.io/badge/Download-RiotSwitcher%20Setup-2ea44f?style=for-the-badge&logo=windows&logoColor=white)](https://github.com/yassine808/RiotSwitcher/releases/latest/download/RiotSwitcher-Setup.exe)

**[Download the latest `RiotSwitcher-Setup.exe`](https://github.com/yassine808/RiotSwitcher/releases/latest/download/RiotSwitcher-Setup.exe)**
— Windows 10/11, 64-bit.

That link always serves the installer from the newest published release. Prefer
no installation? Use the [portable build](https://github.com/yassine808/RiotSwitcher/releases/latest).

Both builds update themselves from GitHub Releases: the installed app replaces
itself through `electron-updater`, and the portable exe swaps itself in place.
See [docs/UPDATES.md](docs/UPDATES.md) for the feed, the release process and how
to withdraw a bad version.

## How it works

```mermaid
flowchart LR
  A["pick a profile"] --> B["save the current session"]
  B --> C["restore the chosen profile"]
  C --> D["launch the Riot Client"]
  D --> E["the card reads RUNNING"]
```

![Profiles](docs/screenshots/home.png)

![Settings](docs/screenshots/settings.png)

## Development

```powershell
npm install
npm run dev          # Electron + Python backend, data in .\data
npm run typecheck
npm run lint
npm run test         # Vitest
npm run test:py      # pytest
npm run build
```

Python must stay 3.9-compatible. The backend talks to Electron over JSON lines;
see [AGENTS.md](AGENTS.md) for the architecture and the hard safety rules around
Riot Client and VALORANT files.

## License

GPL-3.0. See [LICENSE](LICENSE).
