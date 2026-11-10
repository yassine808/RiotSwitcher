## TODO


- [ ] Point the support in the app to my PayPal: paypal.me/yassinemagri
- [ ] Make it show the first time when the user opens it.
- [ ] And maybe every 2 weeks.
- [ ] Make a Cloudflare bucket for the update feed.
- [ ] fix app spams riot to launch valorant, which  blocks riot if theer's an update
- [ ] `isPortableBuild()` trusts `PORTABLE_EXECUTABLE_FILE` from the environment, so an installed build launched from another portable Electron app takes the portable update path. Require the process to run from the temp extraction too.
- [ ] Move the update feed off the `r2.dev` URL to a custom domain on the bucket. Cloudflare rate-limits `r2.dev` and says not to use it in production. Keep `r2.dev` enabled afterwards: builds up to 3.1.x have it compiled in.
- [ ] The bucket is public by design (an installed copy has no credentials). Nothing secret is in it; do not put one there.
- [ ] add arguments for the riotswitcher.exe so that shortcut do the account switch, then exit