param(
  [Parameter(Mandatory = $true)][string]$InputDir,
  [string]$OutputDir = (Join-Path $env:TEMP ('slideapp-pptx-powerpoint-' + [guid]::NewGuid().ToString('N')))
)
$ErrorActionPreference = 'Stop'
New-Item -ItemType Directory -Path $OutputDir -Force | Out-Null
$powerPoint = New-Object -ComObject PowerPoint.Application
$metrics = @()
$editableMetrics = @()
try {
  foreach ($file in Get-ChildItem -LiteralPath $InputDir -Filter '*.pptx' | Sort-Object Name) {
    $presentation = $null
    $model = Get-Content -LiteralPath (Join-Path $InputDir ($file.BaseName + '.json')) -Raw -Encoding UTF8 | ConvertFrom-Json
    try {
      $presentation = $powerPoint.Presentations.Open($file.FullName, $true, $false, $false)
      for ($index = 1; $index -le $presentation.Slides.Count; $index++) {
        $slide = $presentation.Slides.Item($index)
        $tables = @($model.slides[$index - 1].parts | Where-Object kind -EQ 'table')
        $tableIndex = 0
        $slide.Export((Join-Path $OutputDir ($file.BaseName + '-' + $index + '.png')), 'PNG', 1280, 720)
        $editableShapes = @()
        $editableCells = @()
        foreach ($shape in $slide.Shapes) {
          if ($shape.HasTable -eq -1) {
            $expectedTable = $tables[$tableIndex++]
            $rows = @()
            for ($row = 1; $row -le $shape.Table.Rows.Count; $row++) {
              $expectedHeight = $expectedTable.rowHeights[$row - 1] * 0.75
              if ([Math]::Abs($shape.Table.Rows.Item($row).Height - $expectedHeight) -gt 0.02) {
                throw "PowerPoint grew a measured table row: $($file.Name), slide $index, row $row"
              }
              $cells = @()
              for ($column = 1; $column -le $shape.Table.Columns.Count; $column++) {
                $text = $shape.Table.Cell($row, $column).Shape.TextFrame.TextRange
                if ($shape.Table.Cell($row, $column).Shape.HasTextFrame -ne -1) { throw "Table cell is not editable: $($file.Name), slide $index" }
                $editableCells += $text.Text
                $cells += @{ text = $text.Text; lines = $text.Lines().Count }
              }
              $rows += @{ height = $shape.Table.Rows.Item($row).Height; cells = $cells }
            }
            $metrics += @{ fixture = $file.BaseName; slide = $index; top = $shape.Top; height = $shape.Height; rows = $rows }
          }
          if ($shape.HasTextFrame -eq -1 -and $shape.TextFrame.HasText -eq -1) {
            $editableShapes += @{ name = $shape.Name; hasTextFrame = $true; text = $shape.TextFrame.TextRange.Text }
            foreach ($textPart in @($model.slides[$index - 1].parts | Where-Object { $_.kind -eq 'text' -and $_.paragraph.wrap -eq $false })) {
              $expectedText = ($textPart.paragraph.runs | ForEach-Object text) -join ''
              if ($shape.TextFrame.TextRange.Text -eq $expectedText -and $shape.TextFrame.TextRange.Lines().Count -ne 1) {
                throw "PowerPoint wrapped a fitted heading: $($file.Name), slide $index"
              }
            }
          }
        }
        # Check actual COM objects, not only OOXML or the exporter's model.
        $partsToCheck = @(foreach ($measuredPart in $model.slides[$index - 1].parts) {
          if ($measuredPart.kind -eq 'list' -and $measuredPart.positioned) {
            foreach ($paragraph in $measuredPart.paragraphs) { @{ kind='list'; paragraphs=@($paragraph) } }
          } else { $measuredPart }
        })
        foreach ($part in $partsToCheck) {
          $expectedText = $null
          if ($part.kind -eq 'text') { $expectedText = ($part.paragraph.runs | ForEach-Object text) -join '' }
          if ($part.kind -eq 'list') { $expectedText = ($part.paragraphs | ForEach-Object { ($_.runs | ForEach-Object text) -join '' }) -join "`n" }
          if ($null -ne $expectedText) {
            $expectedText = $expectedText.Replace("`r`n", "`n").Replace("`r", "`n").Replace([char]11, [char]10).Trim()
            $matching = @($editableShapes | Where-Object { $_.text.Replace("`r`n", "`n").Replace("`r", "`n").Replace([char]11, [char]10).Trim() -eq $expectedText })
            if ($matching.Count -eq 0) { throw "Native text missing from PowerPoint Shapes.HasTextFrame: $($file.Name), slide $index, $expectedText" }
          }
        }
        if ($tableIndex -ne $tables.Count) { throw "Native table missing from PowerPoint: $($file.Name), slide $index" }
        $editableMetrics += @{ fixture = $file.BaseName; slide = $index; textShapes = $editableShapes; tableCells = $editableCells; tableCount = $tableIndex }
      }
    } finally {
      if ($null -ne $presentation) { $presentation.Close(); [void][Runtime.InteropServices.Marshal]::ReleaseComObject($presentation) }
    }
  }
  $metrics | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath (Join-Path $OutputDir 'table-metrics.json') -Encoding utf8
  $editableMetrics | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath (Join-Path $OutputDir 'editable-metrics.json') -Encoding utf8
  Write-Output $OutputDir
} finally {
  $powerPoint.Quit()
  [void][Runtime.InteropServices.Marshal]::ReleaseComObject($powerPoint)
}
