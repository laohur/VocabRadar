# VocabRadar 浏览器扩展 打包脚本（PowerShell 版，替代 build.py）
# 用法：powershell -ExecutionPolicy Bypass -File build.ps1

$ErrorActionPreference = "Stop"

# 反思（2026-08-28）：脚本移入 scripts/ 子目录后 ROOT 未同步调整（与 build.py 同一 bug），
#   $PSScriptRoot 指向 scripts/ 导致找不到 manifest.json 与 src/。修正为其父目录。
$ROOT = Split-Path $PSScriptRoot -Parent
$DIST = Join-Path $ROOT "dist"
$ZIP_PATH = Join-Path $ROOT "vocabradar-extension.zip"

Write-Host "=== VocabRadar 打包 ==="

# 1. 清理旧 dist
if (Test-Path $DIST) {
    Remove-Item -Recurse -Force $DIST
}
New-Item -ItemType Directory -Path $DIST | Out-Null

# 2. 复制运行时文件
$runtimeItems = @("manifest.json", "src")
foreach ($item in $runtimeItems) {
    $src = Join-Path $ROOT $item
    if (-not (Test-Path $src)) {
        Write-Host "[警告] 缺失: $item"
        continue
    }
    $dst = Join-Path $DIST $item
    if (Test-Path $src -PathType Container) {
        Copy-Item -Recurse -Force $src $dst
    } else {
        Copy-Item -Force $src $dst
    }
    Write-Host "[复制] $item"
}

# 2b. 复制图标文件（manifest.json 中 icons 引用，需在 dist 根目录）
# 反思（2026-08-06）：旧版漏复制图标，导致加载扩展时报
#   "Couldn't load icon icon16.png specified in icons"
$iconFiles = @("icon16.png", "icon32.png", "icon48.png", "icon128.png")
foreach ($icon in $iconFiles) {
    $iconSrc = Join-Path $ROOT $icon
    if (Test-Path $iconSrc) {
        Copy-Item -Force $iconSrc (Join-Path $DIST $icon)
        Write-Host "[复制] $icon"
    } else {
        Write-Host "[警告] 缺失: $icon"
    }
}

# 3. 复制微信小程序码
$mpSrc = Join-Path $ROOT "微信小程序码.jpg"
$mpDst = Join-Path $DIST "src\data\mp-qr.jpg"
if (Test-Path $mpSrc) {
    $mpDstDir = Split-Path $mpDst -Parent
    if (-not (Test-Path $mpDstDir)) {
        New-Item -ItemType Directory -Path $mpDstDir -Force | Out-Null
    }
    Copy-Item -Force $mpSrc $mpDst
    Write-Host "[复制] 微信小程序码.jpg -> src/data/mp-qr.jpg"
} else {
    Write-Host "[警告] 缺失: 微信小程序码.jpg"
}

# 4. 打包 zip
if (Test-Path $ZIP_PATH) {
    Remove-Item -Force $ZIP_PATH
}
Compress-Archive -Path (Join-Path $DIST "*") -DestinationPath $ZIP_PATH -CompressionLevel Optimal
$sizeKb = [math]::Round((Get-Item $ZIP_PATH).Length / 1024)
Write-Host "[打包] vocabradar-extension.zip ($sizeKb KB)"

Write-Host "=== 打包完成 ==="
Write-Host "dist 目录: $DIST"
Write-Host "zip 文件: $ZIP_PATH"
