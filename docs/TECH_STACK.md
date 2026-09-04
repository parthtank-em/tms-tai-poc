# Tech Stack & Project Reference

Reference sheet for `tms-tai-poc` — the **FreightID ↔ TAI (BrokerTMS)** integration proof of concept.
Versions below are what is actually resolved in `node_modules`, not just the semver ranges in `package.json`.

Last verified: 2026-09-04.

---

## 1. At a glance

| Layer | Technology | Version | Notes |
|---|---|---|---|
| Framework | Next.js | 16.3.4 | App Router, React Server Components |
| UI runtime | React / React DOM | 19.2.8 | |
| Language | TypeScript | 5.9.3 | `strict`, `moduleResolution: bundler` |
| Styling | Tailwind CSS | 4.3.3 | CSS-first config — **no `tailwind.config.js`** |
| PostCSS plugin | `@tailwindcss/postcss` | 4.3.3 | The only PostCSS plugin configured |
| Animation utils | `tw-animate-css` | 1.4.0 | Tailwind v4 replacement for `tailwindcss-animate` |
| Component system | shadcn/ui CLI | 4.20.1 | Style `base-nova` |
| Headless primitives | `@base-ui/react` | 1.7.0 | **Base UI, not Radix** — see §5 |
| Variants | `class-variance-authority` | 0.7.1 | |
| Class merging | `clsx` + `tailwind-merge` | 2.1.1 / 3.6.0 | Combined in `cn()` |
| Icons | `lucide-react` | 1.40.0 | |
| ORM | Prisma | 7.10.0 | CLI + `@prisma/client`, both pinned to 7.10.0 |
| DB driver adapter | `@prisma/adapter-neon` | 7.10.0 | Required — see §4 |
| DB driver | `@neondatabase/serverless` | 1.1.0 | WebSocket pool |
| Database | Neon Postgres (serverless) | — | Region `us-east-2`, database `neondb` |
| Env loading (CLI) | `dotenv` | 17.4.2 | Only for the Prisma CLI — see §4 |
| Linting | ESLint + `eslint-config-next` | 9.39.5 / 16.3.4 | Flat config |
| Fonts | Geist / Geist Mono | — | via `next/font/google` |

---

## 2. Project layout

```
prisma/
  schema.prisma                    # 9 models, 11 enums
  migrations/20260904050524_init/  # applied
src/
  app/                             # App Router
    layout.tsx  page.tsx  globals.css
    api/webhooks/tai/              # inbound from TAI — use cases 1 & 2
      shipment-create/route.ts         # ShipmentCreateUrl
      shipment-detail-update/route.ts  # ShipmentDetailUpdateUrl
      shipment-status-update/route.ts  # ShipmentStatusUpdateUrl
  components/ui/                   # shadcn components land here
    button.tsx
  lib/
    prisma.ts                      # PrismaClient singleton (Neon adapter)
    utils.ts                       # cn()
    tai/
      auth.ts                      # Authorization header check (Basic wins)
      status.ts                    # TAI status/stop labels -> enums
      payload.ts                   # webhook body -> normalized shape
      process.ts                   # normalized shape -> DB upserts
      receive.ts                   # shared route: auth -> log -> 200 -> after()
  generated/prisma/                # generated client — GITIGNORED
docs/
  FreightID_TAI_Integration_Findings.md   # domain spec, the source of the data model
  3rd Party Integrations.docx             # original internal use-case doc
  TECH_STACK.md                           # this file
postman/                           # importable collection + dummy webhook payloads
components.json                    # shadcn config
prisma.config.ts                   # Prisma CLI config
```

Path alias: `@/*` → `./src/*`.

---

## 3. Scripts

| Command | Runs | Purpose |
|---|---|---|
| `npm run dev` | `next dev` | Dev server |
| `npm run build` / `start` | `next build` / `next start` | Production |
| `npm run lint` | `eslint` | |
| `npm run db:migrate` | `prisma migrate dev` | Create + apply a migration (dev only, interactive) |
| `npm run db:deploy` | `prisma migrate deploy` | Apply existing migrations (prod/CI) |
| `npm run db:status` | `prisma migrate status` | What's applied vs. pending |
| `npm run db:reset` | `prisma migrate reset` | **Drops all data**, replays migrations |
| `npm run db:push` | `prisma db push` | Schema sync without a migration file |
| `npm run db:studio` | `prisma studio` | Row browser GUI |
| `npm run db:generate` | `prisma generate` | Regenerate client by hand |
| `npm run db:format` / `db:validate` | `prisma format` / `validate` | |
| *(automatic)* `postinstall` | `prisma generate` | Recreates the gitignored client after install |

Add a migration name inline: `npm run db:migrate -- --name add_pod_fields`.

---

## 4. Database & Prisma — the non-obvious parts

**Prisma 7 has no built-in database driver.** The Rust query engine is gone; every `PrismaClient` must be
constructed with a driver adapter. `src/lib/prisma.ts` does this:

```ts
new PrismaClient({ adapter: new PrismaNeon({ connectionString }) })
```

Forgetting the adapter is a runtime error, not a type error you'll catch at build.

**The Prisma CLI does not read `.env`.** Its config loader passes `dotenv: false` to c12 deliberately.
`next dev` loads `.env` on its own, the CLI does not — which is why `prisma.config.ts` starts with
`import "dotenv/config"`. Remove that line and every `db:*` script breaks while the app keeps working.

**The generated client is gitignored** (`/src/generated/`). It's TypeScript source compiled by `tsc`, not a
prebuilt package, and `postinstall` regenerates it. CI needs no extra step; a fresh clone does need
`npm install` before `tsc` will pass.

**Pooled vs. unpooled connection.** `DATABASE_URL` points at Neon's `-pooler` host, which is right for the
app. Migrations take a session-level advisory lock that the pooler doesn't honour, so `prisma.config.ts`
prefers `DIRECT_URL` when set and falls back to `DATABASE_URL`. See §7 — `DIRECT_URL` is not set yet.

**Client singleton.** `globalThis` caches the client outside production so `next dev` hot-reloads don't open
a new Neon pool per edit. Import as `import { prisma } from "@/lib/prisma"` — server-side only (Server
Components, route handlers, server actions). Never from a Client Component; the adapter opens real sockets.

**Schema conventions** (already established in `prisma/schema.prisma`, follow them):
- `@id @default(uuid())` string PKs.
- camelCase fields with `@map` to snake_case columns, `@@map` to snake_case plural tables.
- TAI's own identifiers are stored as separate nullable `tai*Id` integer columns.
- `///` doc comments cite the section of `FreightID_TAI_Integration_Findings.md` a decision came from.

---

## 5. UI layer — Base UI, not Radix

shadcn style is **`base-nova`**, which builds on `@base-ui/react` rather than `@radix-ui/*`. This matters
when copying code from the wider shadcn ecosystem: most snippets online import from `@radix-ui/react-*`
and will not work here. `src/components/ui/button.tsx` imports `@base-ui/react/button`.

`components.json` settings that drive the CLI:

| Key | Value |
|---|---|
| `style` | `base-nova` |
| `rsc` | `true` (adds `"use client"` only where needed) |
| `baseColor` | `neutral` |
| `cssVariables` | `true` |
| `iconLibrary` | `lucide` |

Add components with `npx shadcn@latest add <name>` — they land in `src/components/ui/`.

**Tailwind v4 is CSS-first.** There is no `tailwind.config.js`; theme tokens live in `src/app/globals.css`
under `@theme inline`, with `oklch()` colour variables on `:root` and a `.dark` variant defined via
`@custom-variant dark`. To change the palette, edit the CSS variables, not a config file.

`globals.css` imports, in order: `tailwindcss`, `tw-animate-css`, `shadcn/tailwind.css`.

---

## 6. Domain context

The data model exists to serve four use cases from `docs/FreightID_TAI_Integration_Findings.md`:

1. Shipment created in TAI → FreightID (inbound webhook)
2. Shipment details updated in TAI → FreightID (inbound webhook)
3. FreightID-internal lifecycle (driver assigned/verified, arrived, picked up, in transit, delivered, POD)
4. Security alert / exception → TAI (outbound REST)

Two separate transports with **different auth schemes** — inbound webhooks (static credential, no payload
signing, at-most-once, never retried) and the outbound Public REST API at `https://www.taicloud.net/PublicApi/`.
Consequences already baked into the schema: `WebhookEvent` persists every inbound payload on arrival before
parsing, and `OutboundJob` is the retry/backoff queue every outbound call must go through.

Read the findings doc before touching anything in `prisma/schema.prisma` — the `///` comments reference its
section numbers.

---

## 7. Known gaps

- **`DIRECT_URL` is not set in `.env`.** The init migration ran over the pooled host and succeeded, but
  concurrent-migration safety isn't guaranteed there. Add Neon's unpooled connection string (same host
  without `-pooler`).
- **`.agents/skills/prisma-composer/` and `.claude/skills/prisma-composer/`** were synced by the Prisma
  8.0.0-rc CLI before the downgrade to 7.10.0. They describe Prisma Composer, which the v7 CLI has no
  commands for. Stale — safe to delete.
- **No test framework** is installed. The inbound webhook paths were verified by hand against the live
  Neon database, not by an automated suite.
- **`src/app/layout.tsx` still carries the create-next-app metadata** (`title: "Create Next App"`).
- **Inbound webhook payload field names are guesses.** The findings doc pins down the transport but not the
  body schema, so `src/lib/tai/payload.ts` reads each field through a list of plausible aliases. Confirm
  against a real TAI capture and prune.
- **Use cases 3 and 4 are not built** — no outbound TAI REST client, no `OutboundJob` worker, no alert
  service. `ShipmentLocationUpdateUrl` (optional, §3) has no route either.
- **No UI** beyond a shadcn button smoke test on `/`.

---

## 8. Version tripwires

- `prisma` (CLI) and `@prisma/client` must move **together**. The repo was briefly on CLI `8.0.0-rc.12` with
  client `7.10.0`; those don't pair — v8 is the contract-based "Prisma Next" platform CLI with no
  `generate`/`migrate dev` at all. `prisma generate` will keep advertising the 8.x upgrade; taking it is a
  rewrite, not a bump.
- Tailwind v4 and v3 configuration styles are not interchangeable — v3 answers found online won't apply.
- `@base-ui/react` 1.x is pre-1.0-stable in spirit; check its changelog before upgrading.
