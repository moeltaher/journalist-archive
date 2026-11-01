import {safePublicUrl, sameSite} from './utils.js';

// Cursor pagination advances through the author's listing instead of rereading the first 45.
export const AUTHOR_BATCH_SIZE = 45;
export const MAX_AUTHOR_PAGES_PER_FETCH = 4;
export const MAX_AUTHOR_CANDIDATES_PER_PAGE = 3000;

export function readAuthorCursor(cursor, rootUrl) {
  if (cursor == null) return {pageUrl: safePublicUrl(rootUrl), offset:0};
  if (!cursor || typeof cursor !== 'object' || Array.isArray(cursor)) throw new Error('مؤشر الصفحة التالية غير صالح.');
  const pageUrl = safePublicUrl(cursor.pageUrl);
  const root = new URL(safePublicUrl(rootUrl));
  const current = new URL(pageUrl);
  const rootPath = root.pathname.replace(/\/$/, '') || '/';
  const currentPath = current.pathname.replace(/\/$/, '') || '/';
  if (!sameSite(pageUrl, rootUrl) ||
      (rootPath !== '/' && currentPath !== rootPath && !currentPath.startsWith(rootPath+'/'))) {
    throw new Error('رابط الصفحة التالية لا يتبع صفحة الكاتب الأصلية.');
  }
  if (!Number.isInteger(cursor.offset) || cursor.offset < 0 || cursor.offset > MAX_AUTHOR_CANDIDATES_PER_PAGE) {
    throw new Error('موضع استكمال المقالات غير صالح.');
  }
  return {pageUrl,offset:cursor.offset};
}

export function takeAuthorCandidates(candidates, offset, remaining) {
  if (!Array.isArray(candidates) || !Number.isInteger(offset) || offset < 0 ||
      !Number.isInteger(remaining) || remaining < 1) throw new Error('Invalid candidate slice');
  const ending = Math.min(offset+remaining,candidates.length);
  return {articles:candidates.slice(offset,ending), nextOffset:ending, hasMoreOnPage:ending<candidates.length};
}
