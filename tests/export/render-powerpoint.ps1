param(
  [Parameter(Mandatory = $true)][string]$InputDir,
  [string]$OutputDir = (Join-Path $env:TEMP ('slideapp-pptx-powerpoint-' + [guid]::NewGuid().ToString('N')))
)
$ErrorActionPreference = 'Stop'
New-Item -ItemType Directory -Path $OutputDir -Force | Out-Null
$powerPoint = New-Object -ComObject PowerPoint.Application
$metrics = @()
try {
  foreach ($file in Get-ChildItem -LiteralPath $InputDir -Filter '*.pptx' | Sort-Object Name) {
    $presentation = $null
    $model = Get-Content -LiteralPath (Join-Path $InputDir ($file.BaseName + '.json')) -Raw | ConvertFrom-Json
    try {
      $presentation = $powerPoint.Presentations.Open($file.FullName, $true, $false, $false)
      for ($index = 1; $index -le $presentation.Slides.Count; $index++) {
        $slide = $presentation.Slides.Item($index)
        $tables = @($model.slides[$index - 1].parts | Where-Object kind -EQ 'table')
        $tableIndex = 0
        $slide.Export((Join-Path $OutputDir ($file.BaseName + '-' + $index + '.png')), 'PNG', 1280, 720)
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
                $cells += @{ text = $text.Text; lines = $text.Lines().Count }
              }
              $rows += @{ height = $shape.Table.Rows.Item($row).Height; cells = $cells }
            }
            $metrics += @{ fixture = $file.BaseName; slide = $index; top = $shape.Top; height = $shape.Height; rows = $rows }
          }
          if ($shape.HasTextFrame -eq -1 -and $shape.TextFrame.HasText -eq -1) {
            foreach ($textPart in @($model.slides[$index - 1].parts | Where-Object { $_.kind -eq 'text' -and $_.paragraph.wrap -eq $false })) {
              $expectedText = ($textPart.paragraph.runs | ForEach-Object text) -join ''
              if ($shape.TextFrame.TextRange.Text -eq $expectedText -and $shape.TextFrame.TextRange.Lines().Count -ne 1) {
                throw "PowerPoint wrapped a fitted heading: $($file.Name), slide $index"
              }
            }
          }
        }
      }
    } finally {
      if ($null -ne $presentation) { $presentation.Close(); [void][Runtime.InteropServices.Marshal]::ReleaseComObject($presentation) }
    }
  }
  $metrics | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath (Join-Path $OutputDir 'table-metrics.json') -Encoding utf8
  Write-Output $OutputDir
} finally {
  $powerPoint.Quit()
  [void][Runtime.InteropServices.Marshal]::ReleaseComObject($powerPoint)
}
