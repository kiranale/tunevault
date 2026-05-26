# TuneVault — Email Routing

Last updated: 2026-05-15

## Addresses

| Address | Purpose | Forwards To |
|---------|---------|-------------|
| `hello@tunevault.app` | Questions before buying, partnerships, press | kirankumar.ale@gmail.com |
| `support@tunevault.app` | Existing customers, product issues, account help | kirankumar.ale@gmail.com |

Both addresses currently forward to the same inbox. Split them when dedicated support tooling is adopted (Help Scout, Linear, etc.).

## DNS & Routing Provider

**Cloudflare** manages DNS for `tunevault.app`. Email routing is handled by Cloudflare Email Routing (free tier).

### Current Routes (as of 2026-05-15)

| Rule | Destination |
|------|-------------|
| `hello@tunevault.app` → `kirankumar.ale@gmail.com` | active |
| `support@tunevault.app` → `kirankumar.ale@gmail.com` | **must be added** — see setup below |

### Adding support@ (one-time setup)

1. Log into Cloudflare dashboard → select `tunevault.app` domain
2. Go to **Email** → **Email Routing** → **Routing rules**
3. Click **Create address**
4. Set **Custom address**: `support`
5. Set **Destination**: `kirankumar.ale@gmail.com`
6. Save. Cloudflare sends a verification email to the destination if not already verified.
7. Test: send an email to `support@tunevault.app` from an external account (e.g., a different Gmail). Confirm delivery in `kirankumar.ale@gmail.com` inbox.

Note: Gmail may thread these alongside `hello@` messages since the destination is the same. Filter by To: header in Gmail to separate channels when needed.

## Outbound Email (Transactional)

Transactional emails (magic links, health check completions, alerts) are sent via the **Polsia email proxy** using the `POLSIA_API_KEY` env var. These are sent from a Polsia-managed address, not from the `tunevault.app` domain. No SMTP configuration needed on the app side.

## Where Addresses Appear in the App

- `public/about.html` — Connect section + footer
- `public/index.html` — footer + DPA notice
- `public/blog.html` — author card (hello@ only)
- `routes/blog.js` — individual blog post author aside (hello@ only)
- `routes/seo.js` — JSON-LD Organization contactPoint (hello@)
- `public/index.html` JSON-LD — hello@

If you add a contact form in the future, wire it to `support@` since it's customer-intent traffic.
