import { config } from '../config.js';
import { createDevUserStore } from './usersDev.js';
import { createMssqlUserStore } from './usersMssql.js';

let store;

export async function getUserStore() {
  if (store) return store;
  if (config.dbDriver === 'dev') {
    store = createDevUserStore(config.devUsersPath);
  } else {
    store = createMssqlUserStore(config.mssql);
  }
  await store.ensureSeed({
    username: config.adminUsername,
    name: config.adminName,
    password: config.adminPassword,
  });
  return store;
}
