# Privacy

Beacon is a client. It keeps your conversations in a local cache on your computer and talks to the
Prometheus daemon you point it at. It sends no analytics.

Beacon connects only to:

- **the daemon and services you configure** (your Prometheus, and anything you add in Settings);
- **the sites you open in its browser pane**;
- **github.com/OAraLabs/Beacon**, to download and install updates automatically;
- **github.com/OAraLabs/Prometheus**, only if you ask Beacon to set up Prometheus on your Mac. It checks
  that the download is genuine before it runs it;
- **openrouter.ai**, only if you choose to sign in with OpenRouter. Beacon opens openrouter.ai in your
  browser and connects to it to exchange that sign-in for a key, which it hands to Prometheus and does not
  store.

If a change to Beacon would reach the network anywhere else, this page changes with it, in the same pull
request.
