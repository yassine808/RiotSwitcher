# RiotSwitcher

Windows app that switches between your Riot accounts without typing the
password again. It saves the Riot Client login of each account and puts the
one you pick back in place, so VALORANT and League of Legends start as the
right user. Profiles also carry their ranks, so you can see which account is
which before you switch.

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
