# make_store_images.ps1 —— 生成 Edge / Chrome 商店合规素材（可重复运行）。
# 输入：Screenshot/ 下的原始截图（任意尺寸）；输出：Screenshot/edge-ready/
# 产出：
#   6 张 1280x800 截图（Edge/Chrome 要求 1280x800 或 640x400，此处统一 1280x800）。
#     处理方式：等比缩放适配内容区后居中，浅灰 (#F5F5F5) 背景补边，不裁剪内容。
#   logo-128.png / logo-300.png：由 src/data/icons/icon128.png 生成
#     （Edge logo 最低 128x128 即合规；300x300 为推荐尺寸，128 放大会略糊，两版都给出）。
# Small tile 440x280 / Large tile 1400x560 为可选项，表单无星号，默认不生成。
# 用法：powershell -ExecutionPolicy Bypass -File scripts\make_store_images.ps1
param()
Add-Type -AssemblyName System.Drawing

$proj = Split-Path -Parent $PSScriptRoot
$inDir = Join-Path $proj "Screenshot"
$outDir = Join-Path $inDir "edge-ready"
New-Item -ItemType Directory -Force -Path $outDir | Out-Null

# 截图清单：src 为 Screenshot/ 下原始文件，dst 为输出文件名（英文名避免商店上传歧义）。
$targets = @(
  @{ src = "bilibili.PNG";  dst = "screenshot-1-bilibili.png" },
  @{ src = "youtube1.PNG";  dst = "screenshot-2-youtube.png" },
  @{ src = "视频侧栏.PNG";   dst = "screenshot-3-video-sidebar.png" },
  @{ src = "网页提示.PNG";   dst = "screenshot-4-web-highlight.png" },
  @{ src = "文本侧栏.PNG";   dst = "screenshot-5-text-sidebar.png" },
  @{ src = "chat.PNG";      dst = "screenshot-6-ai-chat.png" }
)

function Convert-ToStoreScreenshot {
  # 将一张原始截图等比缩放并居中放到 WxH 浅灰画布上，输出 PNG（不裁剪内容）。
  param([string]$SrcPath, [string]$DstPath, [int]$W, [int]$H)
  $img = [System.Drawing.Image]::FromFile($SrcPath)
  $bmp = New-Object System.Drawing.Bitmap($W, $H)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.Clear([System.Drawing.Color]::FromArgb(245, 245, 245))
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $r = [Math]::Min($W / $img.Width, $H / $img.Height)
  $nw = [int]($img.Width * $r); $nh = [int]($img.Height * $r)
  $x = [int](($W - $nw) / 2); $y = [int](($H - $nh) / 2)
  $g.DrawImage($img, $x, $y, $nw, $nh)
  $g.Dispose(); $img.Dispose()
  $bmp.Save($DstPath, [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()
}

foreach ($t in $targets) {
  $srcPath = Join-Path $inDir $t.src
  if (-not (Test-Path $srcPath)) { Write-Host "SKIP（不存在）: $($t.src)"; continue }
  Convert-ToStoreScreenshot -SrcPath $srcPath -DstPath (Join-Path $outDir $t.dst) -W 1280 -H 800
  Write-Host "OK 1280x800  $($t.dst)"
}

# logo：icon128 原尺寸复制一份（合规），另出 300x300 放大版（推荐尺寸，略糊）。
$iconPath = Join-Path $proj "src\data\icons\icon128.png"
$icon = [System.Drawing.Image]::FromFile($iconPath)
foreach ($sz in 128, 300) {
  $bmp = New-Object System.Drawing.Bitmap($sz, $sz)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g.DrawImage($icon, 0, 0, $sz, $sz)
  $g.Dispose()
  $bmp.Save((Join-Path $outDir ("logo-{0}.png" -f $sz)), [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()
  Write-Host ("OK logo  {0}x{0}" -f $sz)
}
$icon.Dispose()

Write-Host "完成：$outDir"
