#!/usr/bin/env pwsh
# Script to create a desktop client release
# Usage: .\scripts\create-release.ps1 -Version "1.0.0" -Message "Release message"

param(
    [Parameter(Mandatory=$true)]
    [string]$Version,
    
    [Parameter(Mandatory=$false)]
    [string]$Message = "Desktop client release $Version"
)

$ErrorActionPreference = "Stop"

# Validate version format
if ($Version -notmatch '^\d+\.\d+\.\d+$') {
    Write-Error "Version must be in format X.Y.Z (e.g., 1.0.0)"
    exit 1
}

$Tag = "v$Version"

Write-Host "`n=== Creating Desktop Client Release: $Tag ===" -ForegroundColor Cyan

# Check if tag already exists
$existingTag = git tag -l $Tag
if ($existingTag) {
    Write-Error "Tag $Tag already exists!"
    exit 1
}

# Update package.json version
Write-Host "`nUpdating package.json version..." -ForegroundColor Yellow
$packageJson = Get-Content package.json -Raw | ConvertFrom-Json
$packageJson.version = $Version
$packageJson | ConvertTo-Json -Depth 10 | Set-Content package.json

# Check for uncommitted changes
$status = git status --porcelain
if ($status) {
    Write-Host "`nCommitting version bump..." -ForegroundColor Yellow
    git add package.json
    git commit -m "chore: bump version to $Version"
}

# Create annotated tag
Write-Host "`nCreating tag..." -ForegroundColor Yellow
git tag -a $Tag -m "$Message"

# Show tag info
Write-Host "`n=== Tag Created ===" -ForegroundColor Green
git show $Tag --no-patch

# Confirm push
Write-Host "`n" -NoNewline
$push = Read-Host "Push tag to GitHub and trigger release build? (y/n)"

if ($push -eq 'y') {
    Write-Host "`nPushing changes and tag..." -ForegroundColor Yellow
    git push
    git push origin $Tag
    
    Write-Host "`n=== Success! ===" -ForegroundColor Green
    Write-Host "Tag $Tag pushed to GitHub"
    Write-Host ""
    Write-Host "GitHub Actions will now build installers for:"
    Write-Host "  • Windows (NSIS)"
    Write-Host "  • macOS (DMG)"
    Write-Host "  • Linux (AppImage)"
    Write-Host ""
    Write-Host "Monitor build progress at:"
    Write-Host "https://github.com/ThinkAM/think-am-desktop/actions" -ForegroundColor Cyan
    Write-Host ""
    Write-Host "Installers will be available at:"
    Write-Host "https://github.com/ThinkAM/think-am-desktop/releases/tag/$Tag" -ForegroundColor Cyan
    Write-Host ""
    Write-Host "Release will be marked as LATEST automatically ✨"
} else {
    Write-Host "`nTag created locally but not pushed." -ForegroundColor Yellow
    Write-Host "To push later, run:"
    Write-Host "  git push && git push origin $Tag"
}

Write-Host ""
