# @bitsentry-ce/i18n

Single source of truth for translations across BitSentry's frontend, desktop, and backend. Built on i18next + react-i18next.

## Architecture at a glance

- **One package, all locales.** Every translation lives in `src/locales/<locale>/<namespace>.json`. Frontend, desktop, and backend all consume the same files.
- **Six locales:** `en-US` (source), `en-GB` (UK spelling overrides), `en-AU` (AU spelling overrides), `fr-FR`, `zh-CN`, `id-ID`.
- **Fallback chain:** `en-AU → en-GB → en-US`; everything else falls back directly to `en-US`.
- **Backend** uses `nestjs-i18n` with the same JSON files via `getLocalesPath()` from `@bitsentry-ce/i18n/backend`.
- **Frontend / desktop** use `<I18nProvider>` + `useTranslation()` hook from `@bitsentry-ce/i18n`.

## Namespaces

Each `<namespace>.json` file becomes a separate namespace at runtime. Choose the right namespace when adding new keys:

| Namespace | What goes here | Example values |
|---|---|---|
| `common` | General UI: card titles, field labels, generic actions, status text, table columns | `"Audit Logs"`, `"Last Active:"`, `"Online"` |
| `common.actions.*` | Reusable action verbs shared across components | `Save`, `Cancel`, `Delete`, `Edit`, `Close`, `Saving...` |
| `auth` | Login, signup, MFA, password reset, OTP flows | `"Sign in to BitSentry"`, `"Forgot password?"` |
| `navigation` | Sidebar, breadcrumbs, top-bar menus, footer | `"Log Out"`, `"Dashboard Sections"`, `"No incidents yet"` |
| `dashboard` | Dashboard widgets, metrics, charts | `"Security Score"`, `"Last 30 Days"` |
| `incidents` | Incident management, tickets, resolution | `"New Incident"`, `"Investigation Workspace"` |
| `runbooks` | Runbook editor + execution | `"Run runbook"`, `"Add action"`, `"Step output"` |
| `settings` | Settings pages, user management | `"User Management"`, `"Time zone"` |
| `agents` | Agent configuration UI | `"Add New Agent"`, `"Agent Configuration"` |
| `errors` | Validation, API failure messages, retry prompts | `"Failed to load metrics"`, `"Please enter your email"` |

### Decision tree

1. **Is the string a reusable button or short verb (Save, Cancel, Delete, Close, Edit)?**
   → Use an existing `common.actions.*` key, or add one. Don't create per-component duplicates.

2. **Is it a validation message, error, or "Failed to..." text?**
   → `errors` namespace.

3. **Is it sidebar/breadcrumb/menu chrome?**
   → `navigation` namespace.

4. **Is it specific to a feature (auth flow, runbook UI, dashboard widget)?**
   → That feature's namespace.

5. **Generic UI label that doesn't fit elsewhere?**
   → `common` namespace.

## Adding new translations

### Workflow

1. Write your component in English. The codemod will pick up JSX text + translatable attributes.
2. Run the extractor:
   ```bash
   pnpm i18n:extract --apply --root packages/components/src --namespace common
   ```
3. Review the new keys in `src/locales/en-US/<namespace>.json`. Rename machine-generated suffixes (`_2`, `_3`) to semantic names where useful.
4. Run translation:
   ```bash
   pnpm i18n:translate --apply --locale fr-FR --locale zh-CN --locale id-ID
   ```
   This is idempotent — only new/missing keys hit the API.
5. Run spelling overrides:
   ```bash
   pnpm i18n:translate --apply --task spelling --locale en-GB --locale en-AU
   ```

### Manual workflow (single string)

```tsx
import { useTranslation } from "@bitsentry-ce/i18n";

function MyComponent() {
  const { t } = useTranslation();
  return <Button>{t("common.actions.save")}</Button>;
}
```

For interpolation:
```tsx
t("common.agentModal.deleteConfirm", { name: agent.name })
// Translation: "Are you sure you want to delete \"{{name}}\"? This action cannot be undone."
```

## Scripts

Long-lived i18n maintenance scripts live outside package directories:

- Root repo scripts: `scripts/i18n/`
- CE workspace scripts: `apps/desktop-ce/scripts/i18n/`

| Script | Purpose |
|---|---|
| `extract-strings.mjs` | ts-morph codemod that extracts JSX text, translatable attrs (`placeholder`/`title`/`aria-label`/`alt`/`label`), and call expressions (`toast.*`, `setError(...)`). Emits keys to `en-US/<namespace>.json`. |
| `translate-locales.mjs` | Calls Claude Sonnet to translate `en-US/*.json` → `fr-FR`/`zh-CN`/`id-ID`. Idempotent. Supports `--task spelling` for `en-GB`/`en-AU` overrides. |
| `move-keys.mjs` | Generic key migrator. Reads a `{oldKey: newKey}` map, rewrites all `t(...)` references in source, moves values across all locales. |
| `consolidate-duplicates.mjs` | Wraps `move-keys.mjs` to fold duplicate-value keys into a canonical `common.actions.*` namespace. |
| `audit-hardcoded.mjs` | Reports remaining hardcoded strings the codemod missed (switch cases, label maps, helper functions, concatenations). Use for periodic hygiene checks. |
| `postbuild.mjs` | Copies locale JSON into `dist/locales/` after `tsc` (since tsc doesn't emit JSON). |

Run via npm scripts from the repo root:

```bash
pnpm i18n:build       # tsc + postbuild
pnpm i18n:audit       # find remaining hardcoded strings
pnpm i18n:extract     # run the JSX codemod
pnpm --dir apps/desktop-ce exec node scripts/i18n/translate-locales.mjs --apply --locale fr-FR
```

## Locale resolution

- **Frontend / desktop:** `<I18nProvider>` reads locale from `localStorage` first (key: `bitsentry.locale`), then `navigator.language`. Falls back to `en-US`.
- **Backend:** reads `x-custom-lang` HTTP header (e.g., `en`, `fr`, `zh`, `id`). The `BACKEND_LOCALE_MAP` and `nestjs-i18n` `fallbacks` config map short codes to full locale folders.

## i18next configuration notes

We use `keySeparator: false` and `nsSeparator: false` because keys are stored as flat strings with embedded dots (e.g. `"common.errorFallback.somethingWentWrong"`). This means:
- Don't use `:` or `.` as semantic separators in your t-call argument — they're treated as literal characters.
- `fallbackNS` is set to all namespaces, so a `t()` lookup tries `defaultNS` (common) first, then every other namespace until a match is found.

## Locale-aware formatting

Don't `toLocaleString()` ad-hoc or hardcode `date-fns` formats with `en-US` defaults — use the formatters from this package so dates and numbers follow the user's locale automatically.

```tsx
import { useFormatters } from "@bitsentry-ce/i18n";

function IncidentRow({ incident }) {
  const f = useFormatters();
  return (
    <tr>
      <td>{f.date(incident.createdAt)}</td>
      <td>{f.relativeTime(incident.lastSeenAt)}</td>
      <td>{f.number(incident.eventCount)}</td>
      <td>{f.percent(incident.matchRate, 1)}</td>
    </tr>
  );
}
```

Available: `date`, `time`, `dateTime`, `number`, `percent`, `compact`, `relativeTime`. All wrap the platform `Intl.*` APIs and cache formatter instances. For non-React contexts, the standalone `formatDate`/`formatNumber`/etc. functions accept an explicit locale.

## Locale design notes

- **Long-string handling:** French strings run ~15–25% longer than English. Avoid fixed `w-32` on text-bearing elements; use `min-w-*` or `whitespace-nowrap` + flex shrink. Sonner toasts use `--width: 420px` (set in [packages/components/src/ui/sonner.tsx](../components/src/ui/sonner.tsx)) to fit longer error messages.
- **CJK typography:** `:lang(zh)` CSS layer in [apps/frontend/src/index.css](../../apps/frontend/src/index.css) and [apps/desktop/src/renderer/src/index.css](../../apps/desktop/src/renderer/src/index.css) relaxes line-height to `1.7` and extends the font stack to include `Noto Sans SC`, `PingFang SC`, `Microsoft YaHei`. The `<I18nProvider>` sets `<html lang>` to the active locale, so these selectors apply automatically.
- **Mixed punctuation:** zh-CN translations include full-width Chinese punctuation (`，：。！？`) mixed with Latin numerals/codes — modern browsers handle this correctly without extra config.
- **Empty-state assets:** if you embed text in SVG or image assets, that text won't be translatable. Prefer rendering text with `<text>` outside the asset, or extract baked-in text to translation keys + overlay it on the asset.

## RTL languages

Out of scope today — none of the 6 supported locales are RTL. When Arabic / Hebrew / Persian get added later, every `mr-*`/`ml-*`/`pl-*`/`pr-*` Tailwind class will need conversion to logical properties (`me-*`/`ms-*`/`ps-*`/`pe-*`). Tailwind v4 supports these natively but requires the `tailwindcss-rtl` plugin or manual sweep on v3.

Don't pre-emptively retrofit logical properties now — too much churn for no immediate benefit.

## Adding a new locale

1. Copy `en-US/` → `<new-locale>/` and translate the JSON files.
2. Add the locale to `SUPPORTED_LOCALES` in [src/config.ts](src/config.ts).
3. Add fallback chain entry in `FALLBACK_CHAIN`.
4. Add display info to `LOCALE_DISPLAY` (label, native name, flag).
5. Add backend short-code mapping in `BACKEND_LOCALE_MAP` ([src/backend.ts](src/backend.ts)).
6. Import the new locale's JSONs in [src/instance.ts](src/instance.ts).
7. Update `i18n:translate` script's `ALLOWED` set if needed.

## Re-translating after en-US source changes

`translate-locales.mjs` is idempotent — it only sends keys that don't exist yet in the target locale. To re-translate keys whose English source changed:

1. Delete the affected keys from each target locale JSON (or use `--force` to retranslate everything in a namespace).
2. Run `pnpm i18n:translate --apply --locale fr-FR --locale zh-CN --locale id-ID`.

The `move-keys.mjs` and `consolidate-duplicates.mjs` scripts already preserve translations across renames — no re-translation needed for moves.
