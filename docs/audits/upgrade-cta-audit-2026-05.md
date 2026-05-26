# Upgrade CTA Audit — 2026-05-15

Scope: All paid-tier CTAs across `public/`. Goal: every upgrade path launches Razorpay checkout directly — no mail composer, no contact form.

## Audit Table

| CTA | File:Location | Before | After | Verified |
|-----|--------------|--------|-------|----------|
| Enterprise calculator over-limit block | `pricing.html:1312-1315` | mailto:hello@tunevault.app (opened mail composer) | **Removed** — no limit gate, checkout always available | ✅ |
| "Email us instead" ghost button | `pricing.html:1321-1323` | mailto:hello@tunevault.app link alongside checkout | **Removed** | ✅ |
| email hint below checkout row | `pricing.html:1324-1326` | mailto:hello@tunevault.app plain text link | **Removed** | ✅ |
| Enterprise calculator over-limit block | `settings-billing.html:485-488` | mailto:hello@tunevault.app (500+ conn trigger) | **Removed** | ✅ |
| "Email us instead" ghost button | `settings-billing.html:494` | mailto:hello@tunevault.app link alongside checkout | **Removed** | ✅ |
| TuneBot upgrade FAQ | `tunebot.js:156` | "For Enterprise, use the Email us button or email hello@tunevault.app" | "All tiers go through direct checkout. No sales call required." | ✅ |
| TuneBot plan table | `tunebot.js:146` | Enterprise price = "Custom" | Enterprise price = "$19/conn/mo" | ✅ |
| FAQ "How do I contact Enterprise team?" | `pricing.html:1604` | "For fleets above 50 connections or 15 seats, email hello@tunevault.app" | "Use the calculator to estimate, then proceed to checkout directly. Questions? Email hello@tunevault.app" | ✅ |

## Paths Left as-is (Legitimate)

| CTA | File | Reason |
|-----|------|--------|
| Tier-lock gates → `/pricing` | compliance, api, sso pages | Routes to checkout, not mail |
| Payment error fallback mailto | pricing.html, settings-billing.html | Recovery path for failed Razorpay init, not an upgrade CTA |
| Support links in dashboard | dashboard.html | Genuine support contact, not upgrade path |
| `mailto:support@tunevault.app` throughout | Various | Support channel, not upgrade CTA |

## Backend Guards

- `MAX_ORDER_CENTS = 4_990_000` ($49,900) in `routes/payments.js:226` — real ceiling, returns 400 with user-facing error message
- Backend `create-order` accepts `enterprise` tier directly — no contact step needed

## JS Over-Limit Logic Removed

Both `pricing.html` and `settings-billing.html` had client-side `overLimit` variables that hid the checkout button and showed a mailto block. These are fully removed. The backend MAX_ORDER_CENTS guard is the only gate remaining.
