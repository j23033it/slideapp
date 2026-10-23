param(
  [Parameter(Mandatory = $true)][string]$InputDir,
  [switch]$All,
  [string]$OutputDir = (Join-Path $env:TEMP ('slideapp-css-powerpoint-' + [guid]::NewGuid().ToString('N')))
)
$ErrorActionPreference = 'Stop'
New-Item -ItemType Directory -Path $OutputDir -Force | Out-Null
Add-Type -AssemblyName System.Drawing
$powerPoint = New-Object -ComObject PowerPoint.Application
$metrics = @()
try {
  $fileFilter = if ($All) { '*.pptx' } else { 'audit-*.pptx' }
  foreach ($file in Get-ChildItem -LiteralPath $InputDir -Filter $fileFilter | Sort-Object Name) {
    $presentation = $null
    try {
      $presentation = $powerPoint.Presentations.Open($file.FullName, $true, $false, $false)
      $model = Get-Content -LiteralPath (Join-Path $InputDir ($file.BaseName + '.json')) -Raw -Encoding UTF8 | ConvertFrom-Json
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
        $markerMetrics = @()
        $tableIndex = 0
        $pathIndex = 0
        $pathMetrics = @()
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
            $table = $tableShapes[$tableIndex++].Table
            for ($row = 1; $row -le $table.Rows.Count; $row++) {
              if ([Math]::Abs($table.Rows.Item($row).Height - $part.rowHeights[$row - 1] * .75) -gt .02) { throw "PowerPoint changed a measured table row: $($file.Name), row $row" }
            }
            $cell = $table.Cell(1,1).Shape.TextFrame.TextRange
            $original = $cell.Text; $cell.Text = '編集確認'
            if ($cell.Text -ne '編集確認') { throw 'Table cell edit failed' }
            $cell.Text = $original
          }
          $expected = $null
          if ($part.kind -eq 'text') { $expected = ($part.paragraph.runs | ForEach-Object text) -join '' }
          if ($part.kind -eq 'list') { $expected = ($part.paragraphs | ForEach-Object { ($_.runs | ForEach-Object text) -join '' }) -join "`n" }
          if ($null -eq $expected) { continue }
          $normalized = $expected.Replace("`r", "`n").Replace([char]11, [char]10).Trim()
          $matches = @($textShapes | Where-Object { $_.TextFrame.TextRange.Text.Replace("`r", "`n").Replace([char]11, [char]10).Trim() -eq $normalized })
          if ($matches.Count -eq 0) { throw "Native editable text missing: $expected" }
          $shape = $matches[0]
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
        $metrics += @{ fixture=$file.BaseName; slide=$index; textShapes=$textShapes.Count; tables=$tableShapes.Count; markers=$markerMetrics; paths=$pathMetrics; strokeColors=$strokeColors; inMemoryEditVerified=$true }
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
