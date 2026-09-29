import { build } from 'vite';
process.chdir('D:/AI/海盐县人民医院/信息科登记问题程序/frontend');
const r = await build({ logLevel: 'info' });
console.log('BUILD_DONE', r ? 'ok' : 'done');
