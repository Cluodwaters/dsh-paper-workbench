const {spawn}=require('node:child_process');const {openSync,mkdirSync}=require('node:fs');const path=require('node:path');
const root=path.resolve(__dirname,'..'),directory=path.join(root,'output/office-qa');mkdirSync(directory,{recursive:true});
const log=openSync(path.join(directory,'desktop-session-test.log'),'w');
const child=spawn(process.execPath,[path.join(__dirname,'validate-office.mjs')],{cwd:root,windowsHide:true,stdio:['ignore',log,log]});
child.on('exit',code=>process.exitCode=code||0);
