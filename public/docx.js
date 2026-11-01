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


  // OOXML font sizes are half-points; 1 CSS px = 0.75pt = 1.5 half-points.
  export const ARCHIVE_TITLE = 'الأرشيف';
  export const ARCHIVE_FILENAME = `${ARCHIVE_TITLE}.docx`;
  const PX = Object.freeze({title:22,h1:18,h2:16,p:14,li:14,meta:12,link:12});
  const fontSize = type => Math.round((PX[type] || PX.p) * 1.5);
  const FONT = '<w:rFonts w:ascii="Arial" w:hAnsi="Arial" w:cs="Arial" w:eastAsia="Arial"/>';
  const STYLES = {title:'Title',h1:'Heading1',h2:'Heading2',p:'Normal',li:'Normal',meta:'ArticleMeta',link:'ArticleLink'};
  const AR = /[\u0621-\u064A\u066E-\u06D3\u0750-\u077F\u08A0-\u08C9]/g;
  const LAT = /[a-z]/gi;
  export function detectDocumentDirection(articles) {
    let ar=0, en=0;
    for (const a of articles || []) {
      const texts = [a?.title || '', ...(a?.blocks || []).slice(0,350).map(x=>x?.text || '')];
      for (const value of texts) {
        ar += (String(value).match(AR) || []).length;
        en += (String(value).match(LAT) || []).length;
      }
    }
    return ar >= en ? 'rtl' : 'ltr';
  }
  function directionXml(dir) {
    return dir === 'rtl' ? '<w:bidi/><w:jc w:val="right"/>' : '<w:jc w:val="left"/>';
  }
  function langXml(dir, url=false) {
    return url || dir === 'ltr' ? '<w:lang w:val="en-US"/>' : '<w:lang w:val="ar-SA" w:bidi="ar-SA"/>';
  }
  function run(text,{type='p',direction='rtl',color,bold=false,url=false}={}) {
    const size=fontSize(type);
    const boldXml=bold?'<w:b/><w:bCs/>':'';
    const rtl=direction==='rtl'&&!url?'<w:rtl/>':'<w:rtl w:val="0"/>';
    const colorXml=color?`<w:color w:val="${color}"/>`:'';
    return `<w:r><w:rPr>${FONT}${rtl}${langXml(direction,url)}<w:sz w:val="${size}"/><w:szCs w:val="${size}"/>${boldXml}${colorXml}</w:rPr>`+
      `<w:t xml:space="preserve">${xmlEscape(text)}</w:t></w:r>`;
  }
  function spacing(type) {
    if(type==='title')return '<w:spacing w:before="80" w:after="240" w:line="400" w:lineRule="auto"/>';
    if(type==='h1')return '<w:spacing w:before="260" w:after="140" w:line="350" w:lineRule="auto"/>';
    if(type==='h2')return '<w:spacing w:before="210" w:after="105" w:line="330" w:lineRule="auto"/>';
    if(type==='meta'||type==='link')return '<w:spacing w:before="0" w:after="65" w:line="280" w:lineRule="auto"/>';
    return '<w:spacing w:before="0" w:after="135" w:line="340" w:lineRule="auto"/>';
  }
  function paragraphProps(type,dir,pageBreak=false) {
    const keep=['title','h1','h2'].includes(type)?'<w:keepNext/>':'';
    return `<w:pPr><w:pStyle w:val="${STYLES[type]||'Normal'}"/>${pageBreak?'<w:pageBreakBefore/>':''}${keep}${directionXml(dir)}${spacing(type)}</w:pPr>`;
  }
  function paragraph(text,{type='p',direction='rtl',pageBreak=false}={}) {
    const bold=['title','h1','h2'].includes(type);
    const prefix=type==='li'?'• ':'';
    const color=type==='meta'?'64748B':null;
    return `<w:p>${paragraphProps(type,direction,pageBreak)}${run(prefix+text,{type,direction,bold,color})}</w:p>`;
  }
  function hyperlink(id,url,dir) {
    const label=dir==='rtl'?'الرابط الأصلي: ':'Original link: ';
    const linkRun=`<w:r><w:rPr>${FONT}<w:rtl w:val="0"/>${langXml(dir,true)}`+
      `<w:sz w:val="${fontSize('link')}"/><w:szCs w:val="${fontSize('link')}"/>`+
      '<w:color w:val="2862BC"/><w:u w:val="single"/></w:rPr>'+
      `<w:t xml:space="preserve">${xmlEscape(url)}</w:t></w:r>`;
    return `<w:p>${paragraphProps('link',dir)}`+
      `${run(label,{type:'link',direction:dir,color:'64748B'})}`+
      `<w:hyperlink r:id="${id}" w:history="1">${linkRun}</w:hyperlink></w:p>`;
  }
  function styleXml(id,label,type,dir,{bold=false,outline=null}={}) {
    const size=fontSize(type);
    const attr=id==='Normal'?' w:default="1"':'';
    const basedOn=id==='Normal'?'':'<w:basedOn w:val="Normal"/>';
    const outlineXml=outline===null?'':`<w:outlineLvl w:val="${outline}"/>`;
    const keep=['title','h1','h2'].includes(type)?'<w:keepNext/>':'';
    return `<w:style w:type="paragraph" w:styleId="${id}"${attr}>`+
      `<w:name w:val="${label}"/>${basedOn}<w:qFormat/>`+
      `<w:pPr>${directionXml(dir)}${spacing(type)}${keep}${outlineXml}</w:pPr>`+
      `<w:rPr>${FONT}${langXml(dir)}<w:sz w:val="${size}"/><w:szCs w:val="${size}"/>${bold?'<w:b/><w:bCs/>':''}</w:rPr></w:style>`;
  }
  function stylesXml(dir) {
    return xmlHeader+'<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'+
      `<w:docDefaults><w:rPrDefault><w:rPr>${FONT}${langXml(dir)}<w:sz w:val="${fontSize('p')}"/><w:szCs w:val="${fontSize('p')}"/></w:rPr></w:rPrDefault>`+
      `<w:pPrDefault><w:pPr>${directionXml(dir)}</w:pPr></w:pPrDefault></w:docDefaults>`+
      styleXml('Normal','Normal','p',dir)+
      styleXml('Title','Title','title',dir,{bold:true})+
      styleXml('Heading1','heading 1','h1',dir,{bold:true,outline:0})+
      styleXml('Heading2','heading 2','h2',dir,{bold:true,outline:1})+
      styleXml('ArticleMeta','Article Metadata','meta',dir)+
      styleXml('ArticleLink','Article Link','link',dir)+'</w:styles>';
  }
  export function buildDocx(articles) {
    if (!Array.isArray(articles)||articles.length===0) throw new Error('لا توجد مقالات لإنشاء الملف.');
    const dir=detectDocumentDirection(articles);
    const labels=dir==='rtl'
      ? {author:'الكاتب',site:'الموقع',date:'تاريخ النشر',untitled:'مقال بدون عنوان'}
      : {author:'Author',site:'Publication',date:'Published',untitled:'Untitled article'};
    const body=[paragraph(ARCHIVE_TITLE,{type:'title',direction:dir})], links=[];
    for(let i=0;i<articles.length;i++){
      const a=articles[i];
      body.push(paragraph(a.title||labels.untitled,{type:'h1',direction:dir,pageBreak:i>0}));
      if(a.author)body.push(paragraph(`${labels.author}: ${a.author}`,{type:'meta',direction:dir}));
      if(a.site)body.push(paragraph(`${labels.site}: ${a.site}`,{type:'meta',direction:dir}));
      if(a.date)body.push(paragraph(`${labels.date}: ${a.date}`,{type:'meta',direction:dir}));
      if(a.url&&/^https?:\/\//.test(a.url)){
        const id=`rId${i+1}`;
        links.push(`<Relationship Id="${id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="${xmlEscape(a.url)}" TargetMode="External"/>`);
        body.push(hyperlink(id,a.url,dir));
      }
      for(const block of(a.blocks||[]).slice(0,350)){
        if(!block?.text)continue;
        const type=['h1','h2','h3'].includes(block.type)?'h2':block.type==='li'?'li':'p';
        body.push(paragraph(block.text,{type,direction:dir}));
      }
    }
    const documentXml=xmlHeader+
      '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><w:body>'+
      body.join('')+`<w:sectPr>${dir==='rtl'?'<w:bidi/>':''}<w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1191" w:right="1191" w:bottom="1191" w:left="1191"/></w:sectPr></w:body></w:document>`;
    const relationships=xmlHeader+'<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'+
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>'+
      '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>'+
      '</Relationships>';
    const docRels=xmlHeader+'<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'+
      '<Relationship Id="rIdStyles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>'+
      links.join('')+'</Relationships>';
    const contentTypes=xmlHeader+'<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'+
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>'+
      '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'+
      '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>'+
      '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/></Types>';
    const now=new Date().toISOString().replace(/\.\d+Z$/,'Z');
    const core=xmlHeader+'<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">'+
      `<dc:title>${xmlEscape(ARCHIVE_TITLE)}</dc:title><dc:creator>Journalist Archive</dc:creator>`+
      `<dcterms:created xsi:type="dcterms:W3CDTF">${now}</dcterms:created></cp:coreProperties>`;
    return zipFiles({
      '[Content_Types].xml':contentTypes,'_rels/.rels':relationships,'docProps/core.xml':core,
      'word/document.xml':documentXml,'word/_rels/document.xml.rels':docRels,'word/styles.xml':stylesXml(dir)
    });
  }

