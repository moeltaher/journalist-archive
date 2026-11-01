import test from 'node:test';
import assert from 'node:assert/strict';
import {readAuthorCursor,takeAuthorCandidates,AUTHOR_BATCH_SIZE} from '../src/author-pages.js';

const root='https://example.org/author/journalist';
test('continues within a long author page after 45 articles',()=>{
  const items=Array.from({length:100},(_,i)=>({url:root+'/story-'+i,title:'Story '+i}));
  const first=takeAuthorCandidates(items,0,AUTHOR_BATCH_SIZE);
  assert.equal(first.articles.length,45);
  assert.equal(first.nextOffset,45);
  assert.equal(first.hasMoreOnPage,true);
  const second=takeAuthorCandidates(items,first.nextOffset,AUTHOR_BATCH_SIZE);
  assert.equal(second.articles[0].title,'Story 45');
  assert.equal(second.articles.length,45);
  const third=takeAuthorCandidates(items,second.nextOffset,AUTHOR_BATCH_SIZE);
  assert.equal(third.articles.length,10);
  assert.equal(third.hasMoreOnPage,false);
});
test('allows next page within author path and rejects unrelated links',()=>{
  assert.deepEqual(readAuthorCursor(null,root),{pageUrl:root,offset:0});
  assert.deepEqual(readAuthorCursor({pageUrl:root+'?page=2',offset:12},root),
    {pageUrl:root+'?page=2',offset:12});
  assert.throws(()=>readAuthorCursor({pageUrl:'https://evil.example.net/stories',offset:0},root));
  assert.throws(()=>readAuthorCursor({pageUrl:root,offset:-1},root));
});
