import test from 'node:test';
import assert from 'node:assert/strict';
import {buildDocx, detectDocumentDirection, ARCHIVE_TITLE, ARCHIVE_FILENAME} from '../public/docx.js';

// The app writes an uncompressed OOXML/ZIP file. Read the XML parts without dependencies.
async function zipParts(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const view = new DataView(bytes.buffer);
  const decode = new TextDecoder();
  const files = {};
  let pos = 0;
  while (pos + 30 < bytes.length && view.getUint32(pos, true) === 0x04034b50) {
    const len = view.getUint32(pos + 18, true);
    const nameLen = view.getUint16(pos + 26, true);
    const extraLen = view.getUint16(pos + 28, true);
    const name = decode.decode(bytes.subarray(pos + 30, pos + 30 + nameLen));
    const start = pos + 30 + nameLen + extraLen;
    files[name] = decode.decode(bytes.subarray(start, start + len));
    pos = start + len;
  }
  return files;
}

const ar = {
  title:'الصحافة وحقوق الإنسان في البيئة الرقمية',
  author:'كاتب', site:'موقع إخباري', date:'2026-11-01',
  url:'https://example.org/ar/story?a=1&b=2',
  blocks:[{type:'h2',text:'عنوان فرعي عربي'}, {type:'p',text:'يحتوي هذا المقال على نص عربي عن العمل الصحفي وحفظ المادة المنشورة.'}]
};
const en = {
  title:'Digital Rights and Independent Journalism',
  author:'A Journalist', site:'Example Newspaper', date:'2026-11-01',
  url:'https://example.org/en/story?a=1&b=2',
  blocks:[{type:'h2',text:'English subheading'}, {type:'p',text:'This English article explains why preserving published journalism matters.'}]
};

test('uses the constant Arabic document title and download filename', async () => {
  assert.equal(ARCHIVE_TITLE, 'الأرشيف');
  assert.equal(ARCHIVE_FILENAME, 'الأرشيف.docx');
  const parts = await zipParts(buildDocx([en]));
  assert.ok(parts['word/document.xml'].includes('<w:t xml:space="preserve">الأرشيف</w:t>'));
  assert.ok(parts['docProps/core.xml'].includes('<dc:title>الأرشيف</dc:title>'));
});

test('styles use Arial with requested CSS-pixel sizes converted to OOXML half-points', async () => {
  const parts = await zipParts(buildDocx([ar]));
  const styles = parts['word/styles.xml'];
  for (const [id, halfPoints, bold] of [
    ['Title',33,true],['Heading1',27,true],['Heading2',24,true],
    ['Normal',21,false],['ArticleMeta',18,false],['ArticleLink',18,false]
  ]) {
    const segment=styles.split('<w:style ').find(x=>x.includes('w:styleId="'+id+'"'));
    assert.ok(segment, 'missing style '+id);
    const style=segment.split('</w:style>')[0];
    assert.ok(style.includes('<w:sz w:val="'+halfPoints+'"/>'), 'font size mismatch in '+id);
    assert.ok(style.includes('w:ascii="Arial"'), 'font mismatch in '+id);
    assert.equal(style.includes('<w:b/>'),bold,'bold mismatch in '+id);
  }
});

test('Arabic content is RTL and right-aligned in every paragraph', async () => {
  assert.equal(detectDocumentDirection([ar]),'rtl');
  const parts=await zipParts(buildDocx([ar]));
  const paragraphs=parts['word/document.xml'].split('<w:p>').slice(1).map(x=>x.split('</w:p>')[0]);
  assert.ok(paragraphs.length>=7);
  for(const p of paragraphs) {
    assert.ok(p.includes('<w:bidi/>'),'paragraph missing RTL');
    assert.ok(p.includes('<w:jc w:val="right"/>'),'paragraph missing right alignment');
  }
});

test('English content is LTR and left-aligned in every paragraph', async () => {
  assert.equal(detectDocumentDirection([en]),'ltr');
  const parts=await zipParts(buildDocx([en]));
  const paragraphs=parts['word/document.xml'].split('<w:p>').slice(1).map(x=>x.split('</w:p>')[0]);
  assert.ok(paragraphs.length>=7);
  for(const p of paragraphs) {
    assert.ok(!p.includes('<w:bidi/>'),'unexpected RTL paragraph');
    assert.ok(p.includes('<w:jc w:val="left"/>'),'paragraph missing left alignment');
  }
  assert.ok(parts['word/document.xml'].includes('Original link:'));
  assert.ok(parts['word/document.xml'].includes('Published:'));
});

test('multiple articles start new pages, with a single document title', async () => {
  const parts=await zipParts(buildDocx([ar,ar]));
  const xml=parts['word/document.xml'];
  assert.equal(xml.split('<w:pageBreakBefore/>').length-1,1);
  assert.equal(xml.split('<w:pStyle w:val="Title"/>').length-1,1);
  assert.equal(xml.split('<w:pStyle w:val="Heading1"/>').length-1,2);
});
