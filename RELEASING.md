# Releasing Overstory

How a new version gets from a commit on `main` to the VS Code Marketplace and a GitHub release. The release workflow in `.github/workflows/release.yml` does all of it from a single tag push.

## Every release

1. **Bump the version** in `package.json` (`"version": "0.7.3"`). The Marketplace and the workflow both reject a version that already exists, so this is required.
2. **Add a CHANGELOG entry** under a `## 0.7.3` heading in `CHANGELOG.md`.
3. **Commit, tag and push** (the tag must be `v` + the package version):

   ```bash
   git add -A
   git commit -m "Describe the change"
   git tag v0.7.3
   git push origin main v0.7.3
   ```

4. **Watch the workflow**:

   ```bash
   gh run list --workflow=release.yml --limit 1
   gh run view <run-id> --log-failed    # only if it failed
   ```

   It checks the tag matches `package.json`, runs `npm run package` (typecheck, unit tests, production build, `vsce package`), publishes the resulting `.vsix` to the Marketplace, then creates a GitHub release with that same `.vsix` attached and auto-generated notes.

5. **Verify**. The Marketplace shows the new version under "Verifying" for roughly 5 to 15 minutes, then the listing updates and installed copies auto-update:

   ```bash
   npx vsce show praveendhaked2.overstory
   ```

   - Listing: https://marketplace.visualstudio.com/items?itemName=praveendhaked2.overstory
   - Publisher hub: https://marketplace.visualstudio.com/manage/publishers/praveendhaked2
   - Releases: https://github.com/praveendhaked2/overstory/releases

## Publishing by hand

If the workflow is unavailable, the same two things can be done locally. The token is stored by `npx vsce login praveendhaked2` (see setup below).

```bash
npm run package
npx vsce publish --packagePath dist/overstory.vsix
gh release create v0.7.3 dist/overstory.vsix --generate-notes
```

## One-time setup (already done)

Recorded here so it can be redone if the token expires or the accounts change.

- **Azure DevOps organization** `praveendhaked7`, created with the Microsoft account `praveendhaked7@gmail.com`. It exists only to mint the token. The project inside it is unused.
- **Personal access token**: https://dev.azure.com/praveendhaked7/_usersSettings/tokens, "New Token", with
  - Organization: **All accessible organizations** (a single-org token gets a 401)
  - Scopes: **Custom defined**, "Show all scopes", then **Marketplace: Manage**
  - Expiration: up to one year. Note the date; publishing fails when it lapses.
- **Marketplace publisher** `praveendhaked2` (display name "Praveen Dhaked"), created at https://marketplace.visualstudio.com/manage with the same Microsoft account. The ID must match `"publisher"` in `package.json`.
- **Repository secret** `VSCE_PAT` holding the token, at https://github.com/praveendhaked2/overstory/settings/secrets/actions. The workflow reads it as `secrets.VSCE_PAT`.
- **Local login** for manual publishes: `npx vsce login praveendhaked2`, paste the token.

## When things go wrong

- **Tag pushed but no workflow run.** GitHub skips the tag event when the tag and the workflow file land in the same push, or sometimes when branch and tag are pushed together. Delete and re-push the tag:

  ```bash
  git push --delete origin v0.7.3
  git push origin v0.7.3
  ```

- **"Tag does not match package.json version".** The tag and `"version"` disagree. Fix `package.json`, commit, move the tag (`git tag -f v0.7.3 && git push -f origin v0.7.3`) or use the next number.
- **401 from `vsce publish`.** The token expired, was created for a single organization, or lacks the Marketplace Manage scope. Create a new one as above, update the `VSCE_PAT` secret, run `npx vsce login praveendhaked2` again locally, then re-run the failed workflow job from the Actions tab.
- **"Extension version already exists".** That version is on the Marketplace. Bump to the next patch and release again; versions can't be overwritten.
- **Marketplace stuck on "Verifying" for over an hour.** Re-run the publish with the same `.vsix`. If the hub shows a warning icon instead, click it for the rejection reason.
- **Marketplace publish succeeded but the GitHub release failed.** Re-run the job. The publish step will fail on the duplicate version, so instead create the release by hand with `gh release create` as in "Publishing by hand".

## Related

- `.github/workflows/ci.yml` runs typecheck, tests and the build on every push to `main` and every pull request.
- `.vscodeignore` decides what goes into the `.vsix`; only `dist/extension.js`, `media/`, `package.json`, `README.md`, `LICENSE` and `CHANGELOG.md` are shipped.
