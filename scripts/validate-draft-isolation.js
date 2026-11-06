async(page)=>{
  if(await page.locator('dialog').count())await page.getByRole('button',{name:'关闭对话框',exact:true}).click();
  const target=await page.evaluate(async()=>{const r=await fetch('/api/library/search',{method:'POST',headers:{'Content-Type':'application/json','X-Paper-Workbench':'1'},body:JSON.stringify({query:{text:'[第二阶段界面验收'}})}).then(r=>r.json());return r.items.find(x=>x.title.endsWith('密度 A'));});
  if(!target)throw new Error('Missing isolated test item');
  async function edit(tab,text){await tab.locator('[data-view=all]').click();await tab.locator('[data-select="'+target.id+'"]').click();await tab.getByRole('button',{name:'编辑',exact:true}).click();await tab.locator('[data-field=title]').fill(text);}
  await edit(page,target.title+' · 页签甲草稿');
  const second=await page.context().newPage();await second.goto('http://127.0.0.1:4179');await edit(second,target.title+' · 页签乙草稿');
  const ownerA=await page.evaluate(()=>sessionStorage.getItem('paper-workbench:draft-owner'));
  const ownerB=await second.evaluate(()=>sessionStorage.getItem('paper-workbench:draft-owner'));
  if(ownerA===ownerB)throw new Error('Different tabs shared a draft owner');
  await second.reload();await second.locator('[data-select="'+target.id+'"]').click();
  const values={a:await page.locator('[data-field=title]').inputValue(),b:await second.locator('[data-field=title]').inputValue()};
  const passed=values.a.endsWith('页签甲草稿')&&values.b.endsWith('页签乙草稿');if(!passed)throw new Error(JSON.stringify(values));
  for(const tab of [second,page]){await tab.getByRole('button',{name:'重新载入',exact:true}).click();await tab.getByRole('button',{name:'丢弃草稿并载入',exact:true}).click();}
  await second.close();return {passed,separateOwners:true,draftsRestoredIndependently:true,values};
}
