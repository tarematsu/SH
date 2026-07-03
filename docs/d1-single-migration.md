# D1 migration: one file at a time

The production build does not apply every pending migration automatically.
Set `D1_MIGRATION_NAME` to one exact filename when a specific migration is ready.

Example for the email stream foundation:

```powershell
$env:CF_PAGES_BRANCH = "main"
$env:D1_MIGRATION_NAME = "003_email_stream_snapshots.sql"
$env:D1_MIGRATION_TARGET = "remote"
npm --prefix site run db:migrate
```

The runner creates a temporary migration directory containing only the selected file.
Wrangler therefore cannot apply other pending migrations such as 015 through 019 in the same run.

Before remote application, run the focused local check:

```powershell
npm --prefix site run test:d1:email-foundation
```

After the remote migration succeeds, remove `D1_MIGRATION_NAME` from the build environment so later builds remain read-only with respect to D1 migrations.
