import { describe, expect, it } from 'vitest'
import { strToU8, zipSync } from 'fflate'
import { parseXlsxPreview } from './xlsxPreview'

function createWorkbookBlob(): Blob {
  const files = {
    '[Content_Types].xml': `<?xml version="1.0" encoding="UTF-8"?>
      <Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
        <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
        <Default Extension="xml" ContentType="application/xml"/>
        <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
        <Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
        <Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
      </Types>`,
    '_rels/.rels': `<?xml version="1.0" encoding="UTF-8"?>
      <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
        <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
      </Relationships>`,
    'xl/workbook.xml': `<?xml version="1.0" encoding="UTF-8"?>
      <workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"
        xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
        <sheets>
          <sheet name="Alpha" sheetId="1" r:id="rId1"/>
          <sheet name="Beta" sheetId="2" r:id="rId2"/>
        </sheets>
      </workbook>`,
    'xl/_rels/workbook.xml.rels': `<?xml version="1.0" encoding="UTF-8"?>
      <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
        <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
        <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/>
      </Relationships>`,
    'xl/worksheets/sheet1.xml': worksheetXml('Name', 'Codex'),
    'xl/worksheets/sheet2.xml': worksheetXml('Count', '42', true),
  }
  const zipped = zipSync(
    Object.fromEntries(Object.entries(files).map(([path, content]) => [path, strToU8(content)])),
  )
  const blob = new Blob([], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  })
  Object.defineProperty(blob, 'arrayBuffer', {
    value: async () => zipped.buffer.slice(
      zipped.byteOffset,
      zipped.byteOffset + zipped.byteLength,
    ),
  })
  return blob
}

function worksheetXml(header: string, value: string, numeric = false): string {
  const valueCell = numeric
    ? `<c r="A2"><v>${value}</v></c>`
    : `<c r="A2" t="inlineStr"><is><t>${value}</t></is></c>`
  return `<?xml version="1.0" encoding="UTF-8"?>
    <worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
      <sheetData>
        <row r="1"><c r="A1" t="inlineStr"><is><t>${header}</t></is></c></row>
        <row r="2">${valueCell}</row>
      </sheetData>
    </worksheet>`
}

describe('parseXlsxPreview', () => {
  it('parses all worksheets into display strings', async () => {
    const preview = await parseXlsxPreview(createWorkbookBlob())

    expect(preview.sheetNames).toEqual(['Alpha', 'Beta'])
    expect(preview.sheets).toEqual({
      Alpha: [['Name'], ['Codex']],
      Beta: [['Count'], ['42']],
    })
  })
})
