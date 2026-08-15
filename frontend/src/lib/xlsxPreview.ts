export interface XlsxPreview {
  sheetNames: string[]
  sheets: Record<string, string[][]>
}

export async function parseXlsxPreview(blob: Blob): Promise<XlsxPreview> {
  const { default: readXlsxFile } = await import('read-excel-file/browser')
  const workbook = await readXlsxFile(blob)
  const sheetNames = workbook.map(sheet => sheet.sheet)
  const sheets: Record<string, string[][]> = {}

  for (const sheet of workbook) {
    sheets[sheet.sheet] = sheet.data.map(row =>
      row.map(cell => cell == null ? '' : String(cell)),
    )
  }

  return { sheetNames, sheets }
}
