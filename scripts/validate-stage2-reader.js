async(page)=>{
  const api=async(path,body)=>page.evaluate(async({path,body})=>{const response=await fetch(path,body?{method:'POST',headers:{'Content-Type':'application/json','X-Paper-Workbench':'1'},body:JSON.stringify(body)}:{});const data=await response.json();if(!response.ok)throw new Error(data.error.message);return data;},{path,body});
  const doc=(await api('/api/documents')).find(item=>item.sampleKey==='sample-10');
  const before=await api('/api/documents/'+doc.id);
  const item=await api('/api/library/items/'+doc.itemId);
  const changedTitle=item.metadata.title.includes('[隔离回归]')?item.metadata.title:item.metadata.title+' [隔离回归]';
  await api('/api/library/items/'+doc.itemId,{requestId:crypto.randomUUID(),expectedRevision:item.revision,metadata:{...item.metadata,title:changedTitle,readingStatus:'reading'}});
  const after=await api('/api/documents/'+doc.id);
  const unchanged=JSON.stringify(before.snapshot)===JSON.stringify(after.snapshot);
  if(!unchanged)throw new Error('Metadata update changed annotations');
  await page.locator('[data-view=all]').click();await page.locator('#search').fill('Mass transport and thermal properties');await page.locator('#search').press('Enter');
  const link=page.locator('tr[data-id="'+doc.itemId+'"] .read-link');await link.waitFor();
  const [reader]=await Promise.all([page.context().waitForEvent('page'),link.click()]);
  await reader.waitForLoadState('domcontentloaded');await reader.locator('#save:enabled').waitFor({timeout:60000});
  await reader.setViewportSize({width:1500,height:1000});
  const restored=await reader.evaluate(async()=>{const a=window.workbench.adapter;await a.flush();return {snapshot:a.snapshot(),state:a.getSaveState(),direct:document.body.classList.contains('direct-reader')};});
  const canonical=list=>JSON.stringify(list.map(a=>[a.id,a.type,a.position,a.color,a.text,a.comment]).sort((a,b)=>a[0].localeCompare(b[0])));
  if(canonical(restored.snapshot.annotations)!==canonical(before.snapshot.annotations))throw new Error('Reader annotations differ after metadata editing');
  await reader.screenshot({path:'output/playwright/stage2-reader-regression.png'});
  await reader.getByRole('button',{name:'导出带标注 PDF',exact:true}).click();
  await reader.waitForFunction(()=>document.querySelector('#notice')?.textContent.includes('已导出修订'),null,{timeout:120000});
  const exported=await reader.locator('#notice').innerText();
  const result={metadataIndependent:unchanged,attachmentId:doc.id,itemId:doc.itemId,annotationCount:restored.snapshot.annotations.length,revision:restored.snapshot.revision,readerSaveState:restored.state,independentReaderPage:restored.direct,exported};
  await reader.close();return result;
}
