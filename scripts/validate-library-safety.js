async (page) => {
  const results=[];
  const check=(name,ok,detail)=>{results.push({name,passed:Boolean(ok),detail});if(!ok)throw new Error(name+': '+JSON.stringify(detail));};
  const api=async(path,body)=>page.evaluate(async({path,body})=>{const r=await fetch(path,body?{method:'POST',headers:{'Content-Type':'application/json','X-Paper-Workbench':'1'},body:JSON.stringify(body)}:{});const d=await r.json();if(!r.ok)throw new Error(d.error.message);return d;},{path,body});
  await page.locator('[data-view=all]').click();
  const tests=await api('/api/library/search',{query:{text:'[第二阶段界面验收',sort:{field:'added',direction:'desc'}}});
  const target=tests.items.find(item=>item.title.endsWith('Nb₅Si₃ 密度 A'));
  const other=tests.items.find(item=>item.title.endsWith('密度 D'));
  if(!target||!other)throw new Error('Run the main UI flow first');
  await page.locator('#search').fill(target.title);await page.locator('#search').press('Enter');
  await page.locator('[data-select="'+target.id+'"]').click();
  await page.getByRole('button',{name:'编辑',exact:true}).click();
  const draftTitle=target.title+' · 未保存草稿';await page.locator('[data-field=title]').fill(draftTitle);
  const before=await api('/api/library/items/'+target.id);
  await api('/api/library/items/'+target.id,{requestId:crypto.randomUUID(),expectedRevision:before.revision,metadata:{...before.metadata,publisher:'另一客户端更新'}});
  await page.getByRole('button',{name:'保存信息',exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('#editor-error')?.textContent.includes('其他窗口'));
  const preserved=await api('/api/library/items/'+target.id);
  check('stale editor cannot overwrite another client',preserved.metadata.title===target.title&&preserved.metadata.publisher==='另一客户端更新');
  await page.reload();await page.locator('[data-select="'+target.id+'"]').click();
  check('unsaved draft survives page reload',await page.locator('[data-field=title]').inputValue()===draftTitle);
  await page.getByRole('button',{name:'重新载入',exact:true}).click();await page.getByRole('button',{name:'丢弃草稿并载入',exact:true}).click();
  await page.waitForFunction(title=>document.querySelector('[data-field=title]')?.value===title,target.title);
  check('explicit reload shows latest committed metadata',true);

  await page.locator('[data-view=all]').click();
  const delayed=target.title,latest=other.title;
  await page.route('**/api/library/search',async route=>{
    if(route.request().postDataJSON()?.query?.text===delayed)await new Promise(resolve=>setTimeout(resolve,110));
    const response=await route.fetch();await route.fulfill({response});
  });
  try{
    const started=page.waitForRequest(request=>request.url().endsWith('/api/library/search')&&request.postDataJSON()?.query?.text===delayed);
    await page.locator('#search').fill(delayed);await started;
    await page.locator('#search').fill(latest);
    await page.waitForFunction(title=>document.querySelector('#query-chips').textContent.includes(title)&&document.querySelectorAll('#table-body tr').length===1&&document.querySelector('#table-body .paper-title').textContent.trim()===title,latest,{timeout:10000});
    check('late search response cannot replace newer input',true);
  }finally{await page.unroute('**/api/library/search');}

  await page.locator('#new-item').click();
  const manual='[候选信息保护测试] 手工题名 '+Date.now();
  await page.locator('[data-field=title]').fill(manual);
  await page.getByRole('button',{name:'＋ 添加作者'}).click();await page.getByRole('textbox',{name:'作者 1 姓名',exact:true}).fill('人工作者');
  await page.locator('.more-fields summary').click();await page.locator('[data-field=printDate]').fill('2023-05');
  await page.locator('[data-field=doi]').fill('10.1038/nphys1170');
  await page.getByRole('button',{name:'联网补全',exact:true}).click();
  await page.locator('dialog [name=fields][value=title]').waitFor({state:'visible',timeout:20000});
  check('lookup preserves populated title by default',!await page.locator('dialog [name=fields][value=title]').isChecked());
  check('lookup preserves an existing date even when year input is empty',!await page.locator('dialog [name=fields][value=year]').isChecked());
  await page.screenshot({path:'output/playwright/stage2-doi-candidates.png'});
  await page.getByRole('button',{name:'应用到草稿',exact:true}).click();
  check('candidate application changes only selected fields',await page.locator('[data-field=title]').inputValue()===manual&&await page.getByRole('textbox',{name:'作者 1 姓名',exact:true}).inputValue()==='人工作者'&&await page.locator('[data-field=journal]').inputValue()==='Nature Physics');
  const notSaved=await api('/api/library/search',{query:{text:manual}});check('metadata lookup never saves automatically',notSaved.total===0);
  await page.getByRole('button',{name:'重新载入',exact:true}).click();await page.getByRole('button',{name:'丢弃草稿并载入',exact:true}).click();

  return {results,targetId:target.id};
}
