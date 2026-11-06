async (page) => {
  await page.reload();
  const images = await page.evaluate(async () => {
    const images = [...document.querySelectorAll('.zoomable')];
    images.forEach(image => image.loading = 'eager');
    await Promise.all(images.map(image => image.decode()));
    return images.length;
  });
  if(images !== 5) throw new Error('Expected five embedded evidence images');
  if(!await page.getByText('11 项通过',{exact:true}).count()) throw new Error('Desktop test summary missing');
  if(!await page.getByText('尚未实测',{exact:true}).count()) throw new Error('WPS limitation missing');
  await page.locator('#verify').scrollIntoViewIfNeeded();
  await page.screenshot({path:'output/report/第三阶段报告验证区.png'});
  await page.locator('.zoomable').first().click();
  if(!await page.locator('#lightbox').isVisible()) throw new Error('Image zoom did not open');
  await page.getByRole('button',{name:'关闭放大图片'}).click();
  await page.setViewportSize({width:390,height:844});
  const width=await page.evaluate(()=>({viewport:innerWidth,document:document.documentElement.scrollWidth}));
  if(width.document>width.viewport+1) throw new Error('Report overflows narrow viewport');
  return {embeddedImages:images,desktopSummary:true,wpsLimitation:true,imageZoom:true,narrowLayout:true};
}
