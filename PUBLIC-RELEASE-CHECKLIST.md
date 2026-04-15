# AthenaMem Public Release Checklist

## High priority

- [ ] Rewrite git commit author history to remove personal email addresses
- [ ] Choose public-facing git identity
  - Example: `AthenaMem Maintainers <noreply@users.noreply.github.com>`
  - Or GitHub noreply for Chris
- [ ] Force-push cleaned history to GitHub
- [ ] Re-sync Hermes after history rewrite
- [ ] Run fresh-install test from the cleaned repo

## Docs cleanup

- [x] Remove local OpenClaw-specific paths from public examples where possible
- [x] Replace hardcoded clone URL in README quick start with placeholder
- [ ] Final pass for branding, account names, and personal references

## Verify before going public

- [ ] No real email addresses in `git log`
- [ ] No local machine paths in docs/examples unless intentionally documented
- [ ] No private data/config/test artifacts tracked in repo history
- [ ] Fresh install works exactly from README
- [ ] Tag release after clean install passes

## Notes from current audit

### Found in git metadata
- `Chris Valk <chrisvalk@gmail.com>`
- `Athena <athena@valksystems.com>`
- `AthenaMem Core <athena@athenamem.local>`
- `Chris <chris@Openclaw.(none)>`

### Good signs
- `.gitignore` excludes `data/`, `*.db`, `node_modules/`, and `dist/`
- Working tree docs were mostly clean already
