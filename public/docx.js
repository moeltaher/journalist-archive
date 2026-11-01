/** Minimal dependency-free DOCX writer. Uses an uncompressed ZIP/OOXML package. */
const encoder = new TextEncoder();
const xmlHeader = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
const zipSignature = {local:0x04034b50, central:0x02014b50, end:0x06054b50};

export function xmlEscape(value) {
  return String(value ?? '').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\ufffe\uffff]/g, '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

export function safeFilename(input) {
  return String(input || 'مقالات').replace(/[\\/:*?"<>|\u061f\x00-\x1f]/g, '-')
    .replace(/[\s.]+$/g, '').trim().slice(0, 75) || 'مقالات';
}

const crcTable = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    table[n] = c >>> 0;
  }
  return table;
})();
function crc32(bytes) {
  let crc = 0xffffffff;
  for (const b of bytes) crc = crcTable[(crc ^ b) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
function u16(view, at, n) { view.setUint16(at, n, true); }
function u32(view, at, n) { view.setUint32(at, n, true); }

export function zipFiles(contents) {
  const local = [], directory = [];
  let offset = 0;
  for (const [name, value] of Object.entries(contents)) {
    const nameBytes = encoder.encode(name), data = typeof value === 'string' ? encoder.encode(value) : value;
    const crc = crc32(data);
    const h = new Uint8Array(30 + nameBytes.length), v = new DataView(h.buffer);
    u32(v,0,zipSignature.local); u16(v,4,20); u16(v,6,0x0800); u16(v,8,0);
    u16(v,10,0); u16(v,12,0); u32(v,14,crc); u32(v,18,data.length);
    u32(v,22,data.length); u16(v,26,nameBytes.length); u16(v,28,0);
    h.set(nameBytes,30);
    local.push(h, data);
    const central = new Uint8Array(46 + nameBytes.length), cv = new DataView(central.buffer);
    u32(cv,0,zipSignature.central); u16(cv,4,20); u16(cv,6,20);
    u16(cv,8,0x0800); u16(cv,10,0); u16(cv,12,0); u16(cv,14,0);
    u32(cv,16,crc); u32(cv,20,data.length); u32(cv,24,data.length);
    u16(cv,28,nameBytes.length); u16(cv,30,0); u16(cv,32,0);
    u16(cv,34,0); u16(cv,36,0); u32(cv,38,0); u32(cv,42,offset);
    central.set(nameBytes,46); directory.push(central);
    offset += h.length + data.length;
  }
  const directoryLength = directory.reduce((sum, a) => sum + a.length, 0);
  const end = new Uint8Array(22), ev = new DataView(end.buffer);
  u32(ev,0,zipSignature.end); u16(ev,4,0); u16(ev,6,0);
  u16(ev,8,directory.length); u16(ev,10,directory.length);
  u32(ev,12,directoryLength); u32(ev,16,offset); u16(ev,20,0);
  return new Blob([...local,...directory,end], {type:'application/vnd.openxmlformats-officedocument.wordprocessingml.document'});
}

const PSTYLE = '<w:spacing w:before="0" w:after="170" w:line="370" w:lineRule="auto"/><w:bidi/><w:jc w:val="right"/>';
function run(text, opts={}) {
  const size = opts.size || 24;
  return `<w:r><w:rPr><w:rFonts w:ascii="Arial" w:hAnsi="Arial" w:cs="Arial"/>`+
    `<w:rtl/><w:lang w:val="ar-SA"/><w:sz w:val="${size}"/><w:szCs w:val="${size}"/>`+
    `${opts.bold?'<w:b/>':''}${opts.italic?'<w:i/>':''}${opts.color?`<w:color w:val="${opts.color}"/>`:''}</w:rPr>`+
    `<w:t xml:space="preserve">${xmlEscape(text)}</w:t></w:r>`;
}
function paragraph(text, opts={}) {
  const size = opts.type === 'title' ? 34 : opts.type === 'h2' ? 28 : opts.type === 'h3' ? 25 : opts.type === 'meta' ? 20 : 24;
  const optsXml = opts.type === 'title' ? '<w:spacing w:before="80" w:after="300"/><w:bidi/><w:jc w:val="right"/>' :
    opts.type === 'meta' ? '<w:spacing w:before="0" w:after="95"/><w:bidi/><w:jc w:val="right"/>' : PSTYLE;
  const prefix = opts.type === 'li' ? '• ' : '';
  return `<w:p><w:pPr>${optsXml}</w:pPr>${run(prefix + text, {size,bold:['title','h2','h3'].includes(opts.type),italic:opts.type==='meta',color:opts.type==='meta'?'62748A':null})}</w:p>`;
}
function hyperlink(relId, url) {
  return `<w:p><w:pPr><w:bidi/><w:jc w:val="right"/><w:spacing w:after="260"/></w:pPr>`+
    `${run('الرابط الأصلي: ',{size:20,color:'62748A'})}<w:hyperlink r:id="${relId}" w:history="1">`+
    `<w:r><w:rPr><w:color w:val="2862BC"/><w:u w:val="single"/><w:sz w:val="20"/><w:rtl/></w:rPr>`+
    `<w:t xml:space="preserve">${xmlEscape(url)}</w:t></w:r></w:hyperlink></w:p>`;
}

export function buildDocx(articles) {
  if (!Array.isArray(articles) || articles.length === 0) throw new Error('لا توجد مقالات لإنشاء الملف.');
  const body = [], relationships = [];
  for (let i=0; i<articles.length; i++) {
    const a = articles[i];
    if (i > 0) body.push('<w:p><w:r><w:br w:type="page"/></w:r></w:p>');
    body.push(paragraph(a.title || 'مقال بدون عنوان',{type:'title'}));
    if (a.author) body.push(paragraph(`الكاتب: ${a.author}`,{type:'meta'}));
    if (a.site) body.push(paragraph(`الموقع: ${a.site}`,{type:'meta'}));
    if (a.date) body.push(paragraph(`تاريخ النشر: ${a.date}`,{type:'meta'}));
    if (a.url && /^https?:\/\//.test(a.url)) {
      const relId = `rId${i+1}`;
      relationships.push(`<Relationship Id="${relId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="${xmlEscape(a.url)}" TargetMode="External"/>`);
      body.push(hyperlink(relId,a.url));
    }
    for (const block of (a.blocks || []).slice(0, 350)) {
      if (!block?.text) continue;
      const type = ['h2','h3','li'].includes(block.type) ? block.type : 'p';
      body.push(paragraph(block.text,{type}));
    }
  }
  const documentXml = xmlHeader +
    `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><w:body>`+
    body.join('') + `<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1191" w:right="1191" w:bottom="1191" w:left="1191"/></w:sectPr></w:body></w:document>`;
  const styles = xmlHeader + `<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">`+
    `<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Arial" w:hAnsi="Arial" w:cs="Arial"/><w:lang w:val="ar-SA"/></w:rPr></w:rPrDefault>`+
    `<w:pPrDefault><w:pPr><w:bidi/></w:pPr></w:pPrDefault></w:docDefaults></w:styles>`;
  const relationshipXml = xmlHeader + `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">`+
    `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>`+
    `<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>`+
    `</Relationships>`;
  const docRelsXml = xmlHeader + `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">`+
    `<Relationship Id="rIdStyles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>`+
    relationships.join('') + `</Relationships>`;
  const contentTypes = xmlHeader + `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">`+
    `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>`+
    `<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>`+
    `<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>`+
    `<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>`+
    `</Types>`;
  const now = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
  const core = xmlHeader + `<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">`+
    `<dc:title>أرشيف المقالات</dc:title><dc:creator>أرشيف الصحفي</dc:creator>`+
    `<dcterms:created xsi:type="dcterms:W3CDTF">${now}</dcterms:created></cp:coreProperties>`;
  return zipFiles({
    '[Content_Types].xml':contentTypes,
    '_rels/.rels':relationshipXml,
    'docProps/core.xml':core,
    'word/document.xml':documentXml,
    'word/_rels/document.xml.rels':docRelsXml,
    'word/styles.xml':styles
  });
}
