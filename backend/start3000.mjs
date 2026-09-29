// 启动本地开发实例：先设定 env（dotenv 不会覆盖已存在的变量），再加载真正入口。
process.env.DB_DRIVER = 'dev';
process.env.PORT = '3000';
await import('./src/index.js');
