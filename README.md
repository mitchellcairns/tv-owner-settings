# TV Owner Settings

An unofficial web app for changing the settings on Vizio SmartCast TVs from your phone or computer, without the Vizio mobile app.

It uses the pairing API built into the TV (the same one the Vizio app uses): the TV shows a PIN, you type it in, and the app can then read and change any setting in the TV's menus. Everything runs in your browser and talks only to your TV on your home network.

**App:** https://mitchellcairns.github.io/tv-owner-settings/

Not affiliated with or endorsed by VIZIO. Status: prototype.

## Layout

- `web/` – the PWA (static files, published to GitHub Pages)
- `tools/` – Python scripts used to explore the TV's API (discovery, pairing, settings dump)
