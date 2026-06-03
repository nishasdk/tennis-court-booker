# Virgin Active Court Booker

A personal Telegram bot that books tennis courts at my local Virgin Active gym for me.

## Why

My gym's app is unreliable on poor connections, and popular slots go fast. I built a bot I can message from anywhere to check availability and book a court — no app required.

## How it works

A Cloudflare Worker runs in the background and checks court availability throughout the day. When it finds an open slot that matches my preferences, it books it and lets me know via Telegram.

I can also chat with the bot directly to ask when the next check is running, or set up a booking preference interactively using inline buttons — pick a time window, select which days I'm free, and confirm.

## Stack

- **Runtime**: Cloudflare Workers (scheduled + fetch handlers)
- **State**: Cloudflare KV (auth token cache, scheduling state, booking preferences)
- **Notifications**: Telegram Bot API with inline keyboards and callback queries
- **API**: Virgin Active private mobile API, reverse-engineered via mitmproxy

## TODO

- [ ] Support booking group fitness classes (not just courts)
- [ ] Integrate with other platforms for Padel court bookings
- [ ] Support multiple Virgin Active locations via the same API

## Notes

Built for personal use. All credentials are stored as Wrangler secrets and never committed.
