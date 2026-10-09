// 加密态启动入口。务必配合解密 loader 使用：
//   从项目根执行：  node --import ./backend/loader.mjs backend/start-enc.mjs
// 普通（明文）部署也可直接 `node backend/start-enc.mjs` —— loader 缺省不拦截明文，行为等同原启动。
await import('./src/index.js');
