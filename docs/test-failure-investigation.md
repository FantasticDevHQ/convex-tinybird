# Intermittent test failure investigation

Maintainer investigation record, 2026-09-06. These are observations from a bounded local
experiment, not a current reliability guarantee.

[FTD-2746](https://linear.app/dojoco/issue/FTD-2746/name-the-12percent-intermittent-failure-in-the-convex-tinybird-suite)
tracks two reported single-test failures in about 170 runs of the historical 205-test suite,
approximately 1.2% of that sample. Both followed a working-tree change. The failing names and
errors were not retained, so this is not an established current failure rate or a known error
signature. Bounded reproduction attempts did not reproduce it; the cause remains unknown.

The original investigation did not reproduce the failure with cold Vite transforms or concurrent
runs, and ordinary test durations were well below the timeout. These observations did not identify
a cause. A later isolated probe passed all 50 file-order shuffle seeds; delaying the first delivery
module load by 500 ms and 2.5 seconds also passed. The historical source passed 300 repeated runs
and ten first runs after harmless comment edits. Its key locked dependencies match the original
lockfile, but the original machine and Node runtime are unknown. These results do not prove that
every startup or timing failure is excluded.

The current 332-test suite also passed 300 repeated runs. These local probes used Node 24.19.0
on macOS arm64, Vitest 4.1.10, Vite 8.2.1, Convex 1.44.0 and convex-test 0.0.55, with the
repository's patched Workpool 0.4.10. Each run retained verbose stdout and stderr and stopped the
experiment on a nonzero exit. The historical source was `8bfdef0e4`; the current component source
was from `1b3bd226c`. Subsequent main updates during the probe did not change component source.

For future recurrences, follow the [capture and triage procedure](../README.md#intermittent-test-failure-investigation).
