Fixture for the "a committed credential is rejected" leg of `check-no-secrets.test.mjs`.

The `.tinyb` here is **deliberately tracked** and had to be added with `git add -f`, because the
repo's `.gitignore` now lists `.tinyb`. That is the point: the gate reads the git index, so a
fixture proving it catches a committed credential must actually be committed. If someone removes
this file to "clean up a stray token", the positive control silently stops discriminating and the
gate can never fail again. The token below is a fixture string and has never been valid anywhere.
