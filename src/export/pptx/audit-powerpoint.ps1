param(
  [Parameter(Mandatory = $true)][string]$InputDir,
  [switch]$All,
  [switch]$AllowTableRowGrowth,
  [string]$OutputDir = (Join-Path $env:TEMP ('slideapp-css-powerpoint-' + [guid]::NewGuid().ToString('N')))
)
$ErrorActionPreference = 'Stop'
New-Item -ItemType Directory -Path $OutputDir -Force | Out-Null
Add-Type -AssemblyName System.Drawing
$powerPoint = New-Object -ComObject PowerPoint.Application
$metrics = @()
function Assert-FontRuns($textRange, $runs) {
  $offset = 1
  foreach ($run in $runs) {
    if (!$run.text.Length) { continue }
    # Office assigns a theme font to soft-break controls with no glyphs. Check
    # painted spans independently instead of treating that as mixed text fonts.
    foreach ($span in [regex]::Matches($run.text, '[\uD800-\uDBFF][\uDC00-\uDFFF]|[^\r\n]')) {
      $range = $textRange.Characters($offset + $span.Index, $span.Length)
      if ($range.Font.NameAscii -ne $run.style.fontFace) { throw "PowerPoint Latin font mismatch: $($range.Font.NameAscii), expected $($run.style.fontFace)" }
      $point = [char]::ConvertToUtf32($span.Value, 0)
      $isJapanese = @($fontRanges | Where-Object { $point -ge $_[0] -and $point -le $_[1] }).Count -gt 0
      $eastAsian = if ($isJapanese) { 'Noto Sans JP' } else { $run.style.fontFace }
      if ($range.Font.NameFarEast -ne $eastAsian) { throw "PowerPoint East Asian font mismatch for '$($span.Value)': $($range.Font.NameFarEast), expected $eastAsian" }
    }
    $offset += $run.text.Length
  }
}
try {
  $fileFilter = if ($All) { '*.pptx' } else { 'audit-*.pptx' }
  foreach ($file in Get-ChildItem -LiteralPath $InputDir -Filter $fileFilter | Sort-Object Name) {
    $presentation = $null
    try {
      $presentation = $powerPoint.Presentations.Open($file.FullName, $true, $false, $false)
      $model = Get-Content -LiteralPath (Join-Path $InputDir ($file.BaseName + '.json')) -Raw -Encoding UTF8 | ConvertFrom-Json
      $fontRanges = @(if ($model.japaneseRanges) { $model.japaneseRanges -split ',' | ForEach-Object { $bounds = ($_ -replace '^U\+', '') -split '-'; ,@([Convert]::ToInt32($bounds[0], 16), [Convert]::ToInt32($bounds[1], 16)) } })
      $fontAuditPath = Join-Path $InputDir ($file.BaseName + '-font-audit.json')
      $isFontFixture = Test-Path -LiteralPath $fontAuditPath
      $fontAudit = if ($isFontFixture -and (Test-Path -LiteralPath $fontAuditPath)) { Get-Content -LiteralPath $fontAuditPath -Raw -Encoding UTF8 | ConvertFrom-Json } else { $null }
      for ($index = 1; $index -le $presentation.Slides.Count; $index++) {
        $slide = $presentation.Slides.Item($index)
        $slide.Export((Join-Path $OutputDir ($file.BaseName + '-' + $index + '.png')), 'PNG', 1280, 720)
        $strokeColors = $null
        if ($file.BaseName -eq 'path-alpha') {
          # These fixture paths share a horizontal stroke at local y=100.
          # Sample stroke interiors, away from raster/Office antialiasing edges.
          $paintPart = @($model.slides[$index - 1].parts | Where-Object { $_.kind -in @('image','path') })[0]
          $sampleX = $paintPart.rect.x + $(if ($paintPart.kind -eq 'image') { 150 } else { 50 })
          $sampleY = $paintPart.rect.y + $(if ($paintPart.kind -eq 'image') { 100 } else { 0 })
          $bitmap = [System.Drawing.Bitmap]::FromFile((Join-Path $OutputDir ($file.BaseName + '-' + $index + '.png')))
          try {
            $single = $bitmap.GetPixel([int][Math]::Round($sampleX), [int][Math]::Round($sampleY))
            $overlap = $bitmap.GetPixel([int][Math]::Round($sampleX + 100), [int][Math]::Round($sampleY))
            $expectedOverlap = if ($index -eq 2) { 63 } else { 127 }
            if ($single.R -ne 255 -or [Math]::Abs($single.G - 127) -gt 1 -or [Math]::Abs($single.B - 127) -gt 1 -or
                $overlap.R -ne 255 -or [Math]::Abs($overlap.G - $expectedOverlap) -gt 1 -or [Math]::Abs($overlap.B - $expectedOverlap) -gt 1) {
              throw "PowerPoint changed translucent stroke compositing: slide $index, single=$single, overlap=$overlap"
            }
            $strokeColors = @{ single=@($single.R,$single.G,$single.B); overlap=@($overlap.R,$overlap.G,$overlap.B) }
          } finally { $bitmap.Dispose() }
        }
        $textShapes = @($slide.Shapes | Where-Object { $_.HasTextFrame -eq -1 -and $_.TextFrame.HasText -eq -1 })
        $tableShapes = @($slide.Shapes | Where-Object HasTable -EQ -1)
        $defaultFillMetrics = $null
        if ($file.BaseName -eq 'path-default-fill') {
          $pictures = @($slide.Shapes | Where-Object Type -EQ 13)
          $lines = @($slide.Shapes | Where-Object Type -EQ 9)
          $expectedPictures = if ($index -le 3) { 0 } else { 1 }
          $expectedTexts = if ($index -le 3) { 2 } else { 0 }
          $expectedLines = @($model.slides[$index - 1].parts | Where-Object kind -EQ 'line').Count
          if ($pictures.Count -ne $expectedPictures -or $textShapes.Count -ne $expectedTexts -or $lines.Count -ne $expectedLines) {
            throw "Default fill regression: slide $index, pictures=$($pictures.Count), texts=$($textShapes.Count), lines=$($lines.Count)"
          }
          foreach ($lineShape in $lines) {
            $left = [double]$lineShape.Left
            $lineShape.Left = $left + 1
            if ([Math]::Abs($lineShape.Left - $left - 1) -gt .02) { throw 'Native line edit failed' }
            $lineShape.Left = $left
          }
          if ($index -eq 2) {
            $defaultHash = (Get-FileHash -LiteralPath (Join-Path $OutputDir ($file.BaseName + '-1.png'))).Hash
            $noneHash = (Get-FileHash -LiteralPath (Join-Path $OutputDir ($file.BaseName + '-2.png'))).Hash
            if ($defaultHash -ne $noneHash) { throw 'Omitted fill and fill:none changed visible PowerPoint paint' }
          }
          $defaultFillMetrics = @{ pictures=$pictures.Count; lines=$lines.Count; inMemoryLineEditVerified=$true; matchesFillNone=($index -eq 2) }
        }
        $markerMetrics = @()
        $tableIndex = 0
        $tableMetrics = @()
        $pathIndex = 0
        $pathMetrics = @()
        $fontMetrics = @()
        $partsToCheck = @(foreach ($measuredPart in $model.slides[$index - 1].parts) {
          if ($measuredPart.kind -eq 'list' -and $measuredPart.positioned) {
            foreach ($paragraph in $measuredPart.paragraphs) { @{ kind='list'; paragraphs=@($paragraph) } }
          } else { $measuredPart }
        })
        foreach ($part in $partsToCheck) {
          if ($part.kind -eq 'path') {
            $pathIndex++
            $pathName = "SlideApp SVG path $pathIndex"
            $shape = $slide.Shapes.Item($pathName)
            if ($shape.Type -ne 5 -or $shape.Nodes.Count -lt 2) { throw "Native editable freeform missing: $pathName" }
            $point = $shape.Nodes.Item(1).Points
            $x = $point.GetValue(1,1); $y = $point.GetValue(1,2)
            $shape.Nodes.SetPosition(1, $x + 1, $y)
            $changed = $shape.Nodes.Item(1).Points
            if ([Math]::Abs($changed.GetValue(1,1) - $x - 1) -gt .02) { throw 'Freeform node edit failed' }
            $shape.Nodes.SetPosition(1, $x, $y)
            $pathMetrics += @{ name=$pathName; nodes=$shape.Nodes.Count; inMemoryNodeEditVerified=$true }
          }
          if ($part.kind -eq 'table') {
            if ($tableShapes.Count -eq 0) { throw 'Native table missing' }
            $tableShape = $tableShapes[$tableIndex++]
            $table = $tableShape.Table
            $columnWidths = @()
            for ($column = 1; $column -le $table.Columns.Count; $column++) {
              $width = $table.Columns.Item($column).Width
              if ([Math]::Abs($width - $part.columnWidths[$column - 1] * .75) -gt .02) { throw "PowerPoint changed a measured table column: $($file.Name), column $column" }
              $columnWidths += $width
            }
            $rowHeights = @()
            $rowHeightChanges = @()
            $headerPaint = @()
            for ($row = 1; $row -le $table.Rows.Count; $row++) {
              $expectedHeight = $part.rowHeights[$row - 1] * .75
              $actualHeight = $table.Rows.Item($row).Height
              if ([Math]::Abs($actualHeight - $expectedHeight) -gt .02) {
                $change = @{ row=$row; expected=$expectedHeight; actual=$actualHeight; delta=($actualHeight - $expectedHeight) }
                $rowHeightChanges += $change
                if (!$AllowTableRowGrowth -or $actualHeight -lt $expectedHeight) { throw "PowerPoint changed a measured table row: $($file.Name), slide $index, row $row, expected=$expectedHeight actual=$actualHeight" }
                Write-Warning "PowerPoint grew a table row: $($file.Name), slide $index, row $row, expected=$expectedHeight actual=$actualHeight"
              }
              $rowHeights += $actualHeight
              for ($column = 1; $column -le $table.Columns.Count; $column++) {
                $cellShape = $table.Cell($row,$column).Shape
                $measuredCell = $part.rows[$row - 1][$column - 1]
                $expectedText = ($measuredCell.runs | ForEach-Object text) -join ''
                if ($cellShape.TextFrame.TextRange.Text.Replace("`r", "`n").Replace([char]11, [char]10).Trim() -cne $expectedText.Trim()) { throw 'PowerPoint changed table cell text' }
                if ($isFontFixture) { Assert-FontRuns $cellShape.TextFrame.TextRange $measuredCell.runs }
                if ($null -ne $measuredCell.fill -and $measuredCell.fill.transparency -lt 100) {
                  $rgb = [System.Drawing.ColorTranslator]::FromHtml('#' + $measuredCell.fill.color)
                  $officeRgb = [int]$rgb.R + 256 * [int]$rgb.G + 65536 * [int]$rgb.B
                  if ($cellShape.Fill.Visible -ne -1 -or $cellShape.Fill.ForeColor.RGB -ne $officeRgb -or [Math]::Abs($cellShape.Fill.Transparency * 100 - $measuredCell.fill.transparency) -gt .1) { throw 'PowerPoint changed a native table cell fill' }
                }
                if (($file.BaseName -in @('table-background-width','table-inline-decoration') -or $file.BaseName -like 'table-width-wrapped-*' -or ($file.BaseName -like 'probe-*' -and $index -ge 4)) -and $row -eq 1) {
                  if ($cellShape.TextFrame.TextRange.Characters(1).Font.Color.RGB -ne 16777215) { throw 'Table header text is not white' }
                  # Sample the final cell's right edge inside its padding, clear of strokes/glyphs.
                  $sampleX = [int][Math]::Round(($cellShape.Left + $cellShape.Width) / .75 - 3)
                  $sampleY = [int][Math]::Round($cellShape.Top / .75 + 3)
                  $bitmap = [System.Drawing.Bitmap]::FromFile((Join-Path $OutputDir ($file.BaseName + '-' + $index + '.png')))
                  try { $pixel = $bitmap.GetPixel($sampleX, $sampleY) } finally { $bitmap.Dispose() }
                  if ($pixel.R -ne 29 -or $pixel.G -ne 78 -or $pixel.B -ne 216) { throw "Table header background misses final column edge: slide $index, column $column, pixel=$pixel" }
                  $headerPaint += @{ column=$column; x=$sampleX; y=$sampleY; rgb=@($pixel.R,$pixel.G,$pixel.B); whiteText=$true }
                }
              }
            }
            $cell = $table.Cell(1,1).Shape.TextFrame.TextRange
            $original = $cell.Text; $cell.Text = '編集確認'
            if ($cell.Text -ne '編集確認') { throw 'Table cell edit failed' }
            $cell.Text = $original
            $inlineDecoration = @()
            if ($file.BaseName -eq 'table-inline-decoration') {
              $images = @($model.slides[$index - 1].parts | Where-Object kind -EQ 'image')
              $expectedImages = if ($index -eq 1) { 2 } else { 1 }
              if ($images.Count -ne $expectedImages) { throw 'Inline table decoration missing from measured model' }
              $bitmap = [System.Drawing.Bitmap]::FromFile((Join-Path $OutputDir ($file.BaseName + '-' + $index + '.png')))
              try {
                foreach ($image in $images) {
                  $picture = @($slide.Shapes | Where-Object { $_.Type -eq 13 -and [Math]::Abs($_.Left - $image.rect.x * .75) -lt .02 -and [Math]::Abs($_.Top - $image.rect.y * .75) -lt .02 })
                  if ($picture.Count -ne 1 -or $picture[0].ZOrderPosition -ge $tableShape.ZOrderPosition) { throw 'Inline decoration must remain below the transparent native table' }
                  $sampleX = [int][Math]::Round($image.rect.x + $image.rect.width / 2)
                  $sampleY = [int][Math]::Round($image.rect.y + $(if ($index -eq 3) { 1 } else { 2 }))
                  $pixel = $bitmap.GetPixel($sampleX, $sampleY)
                  $expectedRgb = if ($index -eq 1) { @(240,241,242) } elseif ($index -eq 2) { @(255,255,0) } else { @(234,179,8) }
                  if ([Math]::Abs($pixel.R - $expectedRgb[0]) -gt 1 -or [Math]::Abs($pixel.G - $expectedRgb[1]) -gt 1 -or [Math]::Abs($pixel.B - $expectedRgb[2]) -gt 1) { throw "Inline table decoration is covered: slide $index, pixel=$pixel" }
                  $inlineDecoration += @{ x=$sampleX; y=$sampleY; rgb=@($pixel.R,$pixel.G,$pixel.B); belowNativeTable=$true }
                }
              } finally { $bitmap.Dispose() }
              for ($row = 1; $row -le $table.Rows.Count; $row++) {
                for ($column = 1; $column -le $table.Columns.Count; $column++) {
                  $fill = $table.Cell($row,$column).Shape.Fill
                  if ($fill.Visible -eq -1 -and $fill.Transparency -lt .999) { throw 'Native cell fill covers inline decoration' }
                }
              }
              $inlineCell = $table.Cell(2,1).Shape.TextFrame.TextRange
              $originalInline = $inlineCell.Text
              [void]$inlineCell.InsertAfter(' edit')
              if (!$inlineCell.Text.EndsWith(' edit')) { throw 'Decorated native cell edit failed' }
              $inlineCell.Text = $originalInline
            }
            $tableMetrics += @{ columnWidths=$columnWidths; rowHeights=$rowHeights; rowHeightChanges=$rowHeightChanges; headerPaint=$headerPaint; inlineDecoration=$inlineDecoration; inMemoryCellEditVerified=$true }
          }
          $expected = $null
          if ($part.kind -eq 'text') { $expected = ($part.paragraph.runs | ForEach-Object text) -join '' }
          if ($part.kind -eq 'list') { $expected = ($part.paragraphs | ForEach-Object { ($_.runs | ForEach-Object text) -join '' }) -join "`n" }
          if ($null -eq $expected) { continue }
          $normalized = $expected.Replace("`r", "`n").Replace([char]11, [char]10).Trim()
          $matches = @($textShapes | Where-Object { $_.TextFrame.TextRange.Text.Replace("`r", "`n").Replace([char]11, [char]10).Trim() -eq $normalized })
          if ($matches.Count -eq 0) { throw "Native editable text missing: $expected" }
          $shape = $matches[0]
          if ($isFontFixture) {
            if ($file.BaseName -eq 'font-code-default' -and $expected.Contains('const ABC') -and $shape.TextFrame.TextRange.Characters(1,1).Font.NameAscii -ne 'Consolas') { throw 'PowerPoint code font is not Consolas' }
            if ($part.kind -eq 'text') { Assert-FontRuns $shape.TextFrame.TextRange $part.paragraph.runs }
            if ($part.kind -eq 'list') { for ($i = 1; $i -le $part.paragraphs.Count; $i++) { Assert-FontRuns ($shape.TextFrame.TextRange.Paragraphs($i)) $part.paragraphs[$i - 1].runs } }
            $lines = @(for ($i = 1; $i -le $shape.TextFrame.TextRange.Lines().Count; $i++) { $shape.TextFrame.TextRange.Lines($i).Text.Trim() })
            $reference = @(if ($null -ne $fontAudit) { $fontAudit[$index - 1].paragraphs | Where-Object { $_.text -eq $expected } })
            if ($reference.Count -eq 1 -and ($lines -join "`n") -cne ($reference[0].lines -join "`n")) { throw "Preview/PowerPoint line wrap mismatch on slide $index : $expected" }
            $paintedRuns = @($shape.TextFrame.TextRange.Runs() | Where-Object { $_.Text -match '[^\r\n\v]' })
            $fontMetrics += @{ text=$expected; lines=$lines; latin=@($paintedRuns | ForEach-Object { $_.Font.NameAscii }); eastAsian=(($paintedRuns | ForEach-Object { $_.Font.NameFarEast } | Select-Object -Unique) -join ','); previewLinesVerified=($reference.Count -eq 1) }
          }
          if ($part.kind -eq 'list') {
            for ($i = 1; $i -le $part.paragraphs.Count; $i++) {
              $paragraph = $shape.TextFrame.TextRange.Paragraphs($i)
              $bullet = $paragraph.ParagraphFormat.Bullet
              $marker = $part.paragraphs[$i - 1].list.marker
              if ($null -ne $marker -and $marker.character) {
                if ($bullet.Character -ne [int][char]$marker.character) { throw 'PowerPoint substituted a custom marker' }
                if ($bullet.Font.Name -ne $marker.fontFace) { throw "PowerPoint marker font mismatch: $($bullet.Font.Name)" }
                if ([Math]::Abs($bullet.Font.Size - $marker.fontSize * .75) -gt .1) { throw "PowerPoint marker size mismatch: $($bullet.Font.Size)" }
              }
              $markerMetrics += @{ character=$bullet.Character; font=$bullet.Font.Name; size=$bullet.Font.Size; color=$bullet.Font.Color.RGB }
            }
            if ($file.BaseName -eq 'audit-solid-list') {
              $backgrounds = @($slide.Shapes | Where-Object { $_.Fill.Visible -eq -1 -and $_.Fill.ForeColor.RGB -eq 2236962 })
              if ($backgrounds.Count -eq 0 -or $backgrounds[0].ZOrderPosition -ge $shape.ZOrderPosition) { throw 'Dark list background is missing or covers its text' }
              if ($shape.TextFrame.TextRange.Characters(1).Font.Color.RGB -ne 16777215) { throw 'White list text changed' }
            }
          }
          $original = $shape.TextFrame.TextRange.Text
          [void]$shape.TextFrame.TextRange.InsertAfter(' 編集確認')
          if (!$shape.TextFrame.TextRange.Text.Contains('編集確認')) { throw 'Native text edit failed' }
          $shape.TextFrame.TextRange.Text = $original
        }
        if ($file.BaseName -eq 'table-background-width') {
          $expectedTables = if ($index -eq 7) { 0 } else { 1 }
          if ($tableShapes.Count -ne $expectedTables) { throw 'Table background regression lost native tables or failed bounds fallback' }
        }
        if ($file.BaseName -like 'table-width-wrapped-*' -and $tableShapes.Count -ne 1) { throw 'Full-width wrapped table lost editable cells' }
        if ($file.BaseName -eq 'table-inline-decoration' -and $tableShapes.Count -ne 1) { throw 'Decorated inline table lost editable cells' }
        $metrics += @{ fixture=$file.BaseName; slide=$index; textShapes=$textShapes.Count; tables=$tableShapes.Count; tableMetrics=$tableMetrics; markers=$markerMetrics; paths=$pathMetrics; fonts=$fontMetrics; strokeColors=$strokeColors; defaultFill=$defaultFillMetrics; inMemoryEditVerified=$true }
      }
    } finally {
      if ($null -ne $presentation) { $presentation.Saved = -1; $presentation.Close(); [void][Runtime.InteropServices.Marshal]::ReleaseComObject($presentation) }
    }
  }
  $metrics | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath (Join-Path $OutputDir 'com-metrics.json') -Encoding UTF8
  Write-Output $OutputDir
} finally {
  $powerPoint.Quit()
  [void][Runtime.InteropServices.Marshal]::ReleaseComObject($powerPoint)
}
