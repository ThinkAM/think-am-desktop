# 📱 Desktop Client Release Guide

## Quick Release

```powershell
cd D:\dev\github\ThinkAM\think-am-desktop

# Create and push release tag
.\scripts\create-release.ps1 -Version "1.0.0" -Message "First stable release"
```

This will:
1. ✅ Update `package.json` version
2. ✅ Commit version bump
3. ✅ Create git tag
4. ✅ Push to GitHub
5. ✅ Trigger multi-platform build (Windows, macOS, Linux)
6. ✅ Upload installers to GitHub Releases
7. ✅ Mark release as "latest" automatically

---

## What Gets Built

### Windows
- **Installer**: `ThinkAM-Builder-Setup.exe` (NSIS)
- **Auto-updater**: Yes (via electron-builder)

### macOS
- **Installer**: `ThinkAM-Builder.dmg`
- **Auto-updater**: Yes (via electron-builder)

### Linux
- **Installer**: `ThinkAM-Builder.AppImage`
- **Auto-updater**: Yes (via electron-builder)

---

## Auto-Update Configuration

The app is configured to check for updates from:
```
https://github.com/ThinkAM/think-am-desktop/releases/latest
```

### How it works:
1. App starts → checks GitHub API for latest release
2. Compares local version vs remote version
3. If update available → shows notification
4. User clicks "Update" → downloads and installs

### electron-builder config (package.json):
```json
{
  "build": {
    "publish": {
      "provider": "github",
      "owner": "ThinkAM",
      "repo": "think-am-desktop",
      "releaseType": "release"
    }
  }
}
```

---

## Workflow Overview

### `release.yml` (Triggered on tag push)
- **Matrix build**: Windows, macOS, Linux
- **Parallel execution**: All platforms build simultaneously
- **Publish**: electron-builder uploads to GitHub Releases (uses `--publish always`)
- **Mark latest**: Final job marks release as latest
- **Requires**: GH_TOKEN (automatically provided by GitHub Actions)

### `ci.yml` (Triggered on push/PR)
- **Test builds**: All platforms
- **No publish**: Uses `--publish never` flag to skip GitHub release upload
- **Purpose**: Validates builds work without requiring draft release

---

## Manual Steps (if needed)

### Build locally:
```powershell
# Install dependencies
npm install

# Build for your platform
npm run dist:win    # Windows
npm run dist:mac    # macOS
npm run dist:linux  # Linux

# Build and publish (requires GH_TOKEN)
$env:GH_TOKEN = "ghp_your_token"
npm run release:win
```

### Check current version:
```powershell
node -p "require('./package.json').version"
```

### Test auto-updater locally:
```powershell
# Start in dev mode
npm run dev

# Check update manually in DevTools console:
# require('electron').ipcRenderer.send('check-for-updates')
```

---

## Semantic Versioning

Follow [semver](https://semver.org/):

- **MAJOR** (2.0.0): Breaking changes
- **MINOR** (1.1.0): New features, backwards compatible
- **PATCH** (1.0.1): Bug fixes

### Examples:

```powershell
# Bug fix
.\scripts\create-release.ps1 -Version "1.0.1" -Message "Fix connection timeout"

# New feature  
.\scripts\create-release.ps1 -Version "1.1.0" -Message "Add offline mode"

# Breaking change
.\scripts\create-release.ps1 -Version "2.0.0" -Message "New API integration"
```

---

## Pre-releases (Beta/Alpha)

```powershell
# Update package.json manually
# "version": "1.0.0-beta.1"

git add package.json
git commit -m "chore: version 1.0.0-beta.1"
git tag v1.0.0-beta.1
git push && git push origin v1.0.0-beta.1

# Manually mark as pre-release on GitHub
```

---

## Troubleshooting

### Build fails on macOS
- **Issue**: Code signing required
- **Solution**: Skip signing in package.json:
  ```json
  "mac": {
    "identity": null
  }
  ```

### Build fails on Windows
- **Issue**: Missing build tools
- **Solution**: Install Visual Studio Build Tools:
  ```powershell
  npm install --global windows-build-tools
  ```

### Auto-updater not working
- **Check**: Release must be marked as "latest"
- **Check**: `GH_TOKEN` must have `repo` scope
- **Check**: Release must contain platform-specific installer

---

## Links

- **Releases**: https://github.com/ThinkAM/think-am-desktop/releases
- **Actions**: https://github.com/ThinkAM/think-am-desktop/actions
- **Latest Download**: https://github.com/ThinkAM/think-am-desktop/releases/latest
- **electron-builder Docs**: https://www.electron.build/

---

## Next Steps

After creating a release:

1. ✅ Monitor GitHub Actions for build completion (~10-15 min)
2. ✅ Verify installers are uploaded to GitHub Release
3. ✅ Download and test on each platform
4. ✅ Verify auto-update works on existing installs
5. ✅ Update landing page download links

---

**Ready to release?** Run `.\scripts\create-release.ps1` and follow the prompts! 🚀
