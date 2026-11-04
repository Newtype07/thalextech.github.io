# Thalex second screen apps

### Build
To build all apps, run `./build_apps.sh`

If you want to build an individual app, `cd` into the app directory and execute npm commands following the app's README.

### Shared instrument selection

`lib/components/PositionBuilder.vue` owns the option-leg inputs used by Payoff, Simulator, Term Structure's position simulator, and Combo P&L. Its default layout includes the combination heading, shared or per-leg maturities, inline controls, and aggregate Greeks. Apps supply their instruments, quotes or valuations, and leg state.

The builder uses the shared select menu and the position, option-pricing, instrument-contract, and combination-title modules in `lib/`; it has no dependency on app source. The simulator's former position and pricing modules re-export those shared modules to preserve existing imports.

The app's central chart container owns the editor width. The builder fills that container without its own maximum width, border, or background; chart and editor should share a grid column or parent width, with sidebars outside that column.

For charts with internal SVG margins, align the editor to the plotted content using the chart's layout values. Simulator shares its chart width and margins between the renderer and the editor's responsive insets.


## Automated Secrets Scanning

The build pipeline automatically scans pull requests for leaked secrets before
allowing a merge to main. This scan is performed using an open source tool
called [TruffleHog](https://trufflesecurity.com/trufflehog).

### What to do if Secrets are Detected

By default, TruffleHog's output is human readable, and quite useful. If you're
working with scripts or automation, use the `--json` flag to work with JSON
output instead. If you need to read the JSON, it can be made human readable via
`jq '.' scan_result.json`.  Each entry in the JSON represents one detected
secret, and the rest is decently self-explanatory.

For each secret detected, follow the Revoke and Remove sections below.

#### Revoke

1. Decided whether the secret is sensitive or not. If it protects any data or
   access to anything at all, it's sensitive.
2. For sensitive secrets, determine whether the secret has been published.
   If it has been published, the secret is burnt. You need to revoke/rotate it
   before moving on to the Remove section. NOTE: If it was in a PR or branch,
   you should consider it to have been revealed publicly.
3. If it is not sensitive, there is no need to revoke it, so you can move to
   the Remove section.

#### Remove

Even if it's a non-sensitive secret, you need to remove the secret from the
repo so that it will stop triggering TruffleHog. Non-sensitive secrets should
be removed from the repo the same way sensitives ones are; however, if it's a
test secret and not truly sensitive, you can use one of the methods mentioned
in the Ignoring Non-secret Secrets section to ignore the secret, but only if
you can't use best practices to remove it from the final image.

### Ignoring Non-secret Secrets

There are three ways to ask TruffleHog to ignore a secret.

1. Ignore entire files: --exclude-paths
   This flag takes a comma-separated list of paths to files that will be
   ignored by the scanner. To take advantage of it in the CI/CD pipeline,
   append each path you'd like to ignore to `.thog-exclude-paths` in the
   repository root. There should be one path per line in this file.
2. Ignore comment: `trufflehog:ignore`
   Adding this trailing comment to a line will skip that line.
3. Ignore specific secret: Comming soon. Awaiting PR merge.
   https://github.com/trufflesecurity/trufflehog/pull/4436
