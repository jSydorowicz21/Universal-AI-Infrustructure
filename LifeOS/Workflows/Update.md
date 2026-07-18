# Update — idempotent re-overlay after a version bump

Brings an existing install up to the current LifeOS version without touching the user's data. Safe to run repeatedly.

## Voice notification (first action)

```bash
curl -s -X POST http://localhost:31337/notify -H "Content-Type: application/json" \
  -d '{"message": "Running the Update workflow in the LifeOS skill to update your install"}' > /dev/null 2>&1 &
```

## Steps

1. **DetectEnv** — `bun Tools/DetectEnv.ts`. If `isDevTree` → STOP (the source repo updates itself via git, not this workflow).
2. **Version diff** — compare the incoming release tag or `install/LIFEOS/VERSION` with the selected profile's `LIFEOS/VERSION`. If equal, report "already current" and exit.
3. **Overlay managed runtime and skills** — run `bun Tools/DeployCore.ts` without `--apply`, review the plan, then run it with `--apply`. It transactionally replaces each managed top-level runtime/skill entry from the new payload, preserves `USER`, `MEMORY`, unowned skills, and unrelated root files, and rolls back both managed trees and dependency state if a required step fails.
4. **Re-overlay harness-root system files** — update the system-owned routing template, constitution, and managed settings fields for the selected config root without replacing unrelated settings.
5. **Refresh selected enhancements** — if hooks or another optional component is already installed, re-run its deployer to merge new entries/files. Do not opt the user into an enhancement they previously declined.
6. **Scaffold new USER templates only** — `bun Tools/ScaffoldUser.ts` copyMissing adds newly introduced template files and never overwrites existing user content.
7. **Re-activate imports** — `bun Tools/ActivateImports.ts` for newly shipped identity import lines.
8. **Verify** — execute the updated runtime, re-probe every refreshed enhancement, and confirm imports resolve from the selected profile.

## Rule
Update preserves user-owned state and customizations. Managed runtime files are replaced as a unit so old code cannot survive under a new version marker; user data, unowned skills, unrelated settings, and user-added hooks remain intact.
