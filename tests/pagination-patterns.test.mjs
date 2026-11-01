import test from 'node:test';
import assert from 'node:assert/strict';
import {paginationLink, pickArticles} from '../src/utils.js';

const root='https://example.org/author/writer';
const make=(url,text,rel='')=>({url,text,rel});

test('HTML load more is followed with no publisher-specific rule',()=>{
  assert.equal(
    paginationLink([make(root+'?bot=yes&page=1','Load More')],root,root),
    root+'?bot=yes&page=1'
  );
});
test('Arabic load more and accessibility label are recognized',()=>{
  assert.equal(
    paginationLink([{url:root+'?page=2',text:'',ariaLabel:'تحميل المزيد'}],root,root),
    root+'?page=2'
  );
  assert.equal(
    paginationLink([{url:root+'?page=2',text:'',className:'load-more-posts'}],root,root),
    root+'?page=2'
  );
});
test('numeric pagination chooses the nearest forward page, not the last link',()=>{
  const current=root+'?page=2';
  const links=[make(root+'?page=6','6'),make(root+'?page=3','3'),make(root+'?page=1','1')];
  assert.equal(paginationLink(links,current,root),root+'?page=3');
});
test('rel=next supports pagination not explicitly labelled in the UI',()=>{
  assert.equal(
    paginationLink([make(root+'?offset=30','', 'next')],root,root),
    root+'?offset=30'
  );
});
test('does not return previous, external, or unrelated links',()=>{
  assert.equal(paginationLink([make(root+'?page=1','Previous')],root+'?page=2',root),null);
  assert.equal(paginationLink([make('https://other.example.org/author/writer?page=2','Load More')],root,root),null);
  assert.equal(paginationLink([make('https://example.org/category/news?page=2','2')],root,root),null);
});
test('CMS path-based pagination is followed',()=>{
  assert.equal(paginationLink([make(root+'/page/2','2')],root,root),root+'/page/2');
});
test('article picker keeps candidate URLs within site and deduplicates repeated items',()=>{
  const article='https://example.org/stories/12345';
  const result=pickArticles([
    make(article,'هذا عنوان طويل لمقال تقني'),
    make(article+'?utm_source=feed','هذا عنوان طويل لمقال تقني'),
    make(root+'?page=2','Load More')
  ],root);
  assert.equal(result.length,1);
  assert.equal(result[0].url,article);
});


test('explicit AJAX load-more links may legitimately start with offset 0',()=>{
  assert.equal(
    paginationLink([make(root+'?offset=0','Load more posts')],root,root),
    root+'?offset=0'
  );
});
